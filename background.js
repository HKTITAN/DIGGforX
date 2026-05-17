// Digg for X — background service worker.
// All cross-origin fetches to digg.com happen here (CORS-bypass via host_permissions).
// Two-layer cache (in-memory + chrome.storage.local) with per-kind TTLs.
//
// Endpoints we hit (see DIGG_API.md for the full reverse-engineering notes):
//   GET https://digg.com/api/search/users?q=&limit=
//   GET https://digg.com/api/search/stories?q=&limit=
//   GET https://digg.com/api/search/repos?q=&limit=
//   GET https://digg.com/api/trending/status
//   GET https://digg.com/u/x/{username}    (HTML — RSC payload parsed for profile data)
//   GET https://digg.com/ai                (HTML — RSC payload parsed for the feed)
//   GET https://digg.com/ai/{shortId}      (HTML — RSC payload parsed for the cluster)

const ORIGIN = "https://digg.com";
const FETCH_TIMEOUT_MS = 15_000;

// ---------- cache ----------
const memCache = new Map();
const TTL = {
  profile:  30 * 60 * 1000,
  feed:      5 * 60 * 1000,
  story:    10 * 60 * 1000,
  trending: 30 * 1000,
  search:    2 * 60 * 1000,
  negative:  5 * 60 * 1000
};
async function cacheGet(key) {
  const hit = memCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  try {
    const stored = await chrome.storage.local.get(key);
    const row = stored[key];
    if (row && row.exp > Date.now()) {
      memCache.set(key, row);
      return row.val;
    }
  } catch {}
  return null;
}
async function cacheSet(key, val, ttlMs) {
  const row = { val, exp: Date.now() + ttlMs };
  memCache.set(key, row);
  try { await chrome.storage.local.set({ [key]: row }); } catch {}
}

// ---------- fetch with timeout ----------
async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: "omit",
      ...opts,
      signal: ctrl.signal
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- RSC parsing ----------
function extractFlightText(html) {
  const out = [];
  const re = /self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { out.push(JSON.parse('"' + m[1] + '"')); }
    catch {}
  }
  return out.join("");
}

function readJsonObject(text, startIdx) {
  if (text[startIdx] !== "{") return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = startIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try { return [i + 1, JSON.parse(text.slice(startIdx, i + 1))]; }
          catch { return null; }
        }
      }
    }
  }
  return null;
}
function readJsonArray(text, startIdx) {
  if (text[startIdx] !== "[") return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = startIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) {
          try { return [i + 1, JSON.parse(text.slice(startIdx, i + 1))]; }
          catch { return null; }
        }
      }
    }
  }
  return null;
}

function objectAfter(text, key) {
  const needle = `"${key}":`;
  const idx = text.indexOf(needle);
  if (idx < 0) return null;
  const brace = text.indexOf("{", idx + needle.length);
  if (brace < 0) return null;
  // Make sure the brace is the immediate value, not a nested one inside another field.
  // Reject if there's a closing brace, comma, or open-bracket between idx+needle and brace.
  const between = text.slice(idx + needle.length, brace);
  if (/[,}\]]/.test(between)) return null;
  const r = readJsonObject(text, brace);
  return r ? r[1] : null;
}
function arrayAfter(text, key) {
  const needle = `"${key}":`;
  const idx = text.indexOf(needle);
  if (idx < 0) return null;
  const bracket = text.indexOf("[", idx + needle.length);
  if (bracket < 0) return null;
  const between = text.slice(idx + needle.length, bracket);
  if (/[,}\]]/.test(between)) return null;
  const r = readJsonArray(text, bracket);
  return r ? r[1] : null;
}
function stringAfter(text, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`);
  const m = re.exec(text);
  return m ? JSON.parse('"' + m[1] + '"') : null;
}
function numberAfter(text, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*"?(-?[0-9.]+)"?`);
  const m = re.exec(text);
  return m ? Number(m[1]) : null;
}
function stringArrayAfter(text, key) {
  const arr = arrayAfter(text, key);
  if (!Array.isArray(arr)) return null;
  return arr.filter((x) => typeof x === "string");
}

function findCategory(html) {
  // Profile HTML: <a href="/ai/x/rankings?tag=research-engineer" title="View Research Engineer rankings">
  const m1 = /rankings\?tag=([a-z-]+)"[^>]*title="View ([^"]+) rankings/.exec(html);
  if (m1) return { tag: m1[1], label: m1[2] };
  const m2 = /rankings\?tag=([a-z-]+)\\?"[^>]*title=\\?"View ([^"\\]+) rankings/.exec(html);
  if (m2) return { tag: m2[1], label: m2[2] };
  return null;
}
function findHeaderStats(html) {
  const out = {};
  const re = /<span class="font-bold text-foreground">([^<]+)<\/span>\s*(?:<!--[^>]*-->\s*)*([A-Z][A-Z ]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const value = m[1].trim();
    const label = m[2].trim();
    if (/^TOP FOLLOWERS/.test(label)) out.topFollowers = value;
    else if (/^GRAVITY/.test(label))   out.gravity = value;
    else if (/^FOLLOWERS/.test(label)) out.followers = value;
  }
  return out;
}
function findClassification(html) {
  const m = /AI Classification<\/legend>\s*<p[^>]*>([\s\S]*?)<\/p>/.exec(html);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").trim();
}

// ---------- profile ----------
async function getDiggProfile(username) {
  username = String(username || "").replace(/^@/, "").trim();
  if (!username) return null;
  const key = `profile:${username.toLowerCase()}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  // Digg routes user profiles as /u/{platform}/{username}; X handles live
  // under the "x" platform. The bare /u/{username} path 404s.
  const url = `${ORIGIN}/u/x/${encodeURIComponent(username)}`;
  let res;
  try { res = await fetchWithTimeout(url); }
  catch (e) {
    // Network/timeout failure — surface a transient error so the UI can retry.
    // Do NOT cache: we want a retry next visit.
    return { onDigg: false, username, error: String(e && e.message || e) };
  }
  if (res.status === 404) {
    const negative = { onDigg: false, username };
    await cacheSet(key, negative, TTL.negative);
    return negative;
  }
  if (!res.ok) {
    return { onDigg: false, username, error: `HTTP ${res.status}` };
  }
  let html;
  try { html = await res.text(); }
  catch (e) { return { onDigg: false, username, error: String(e) }; }

  const flight = extractFlightText(html);

  const vibe   = objectAfter(flight, "vibeDistribution");
  const topic  = objectAfter(flight, "topicDistribution");
  const tweetCount = numberAfter(flight, "tweetCount");
  const authorXId  = stringAfter(flight, "authorXId");
  const classification = findClassification(html);
  const category = findCategory(html);
  const stats = findHeaderStats(html);

  if (!vibe && !topic && !classification && !category && !stats.gravity) {
    const negative = { onDigg: false, username };
    await cacheSet(key, negative, TTL.negative);
    return negative;
  }

  const profile = {
    onDigg: true,
    username,
    authorXId,
    tweetCount,
    classification,
    category,
    gravity: stats.gravity || null,
    followers: stats.followers || null,
    topFollowers: stats.topFollowers || null,
    vibe,
    topic,
    profileUrl: url
  };
  await cacheSet(key, profile, TTL.profile);
  return profile;
}

// ---------- story (cluster) ----------
async function getDiggStory(slug) {
  slug = String(slug || "").trim();
  if (!slug) return null;
  const key = `story:${slug}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  let res;
  try { res = await fetchWithTimeout(`${ORIGIN}/ai/${encodeURIComponent(slug)}`); }
  catch (e) { return { slug, error: String(e && e.message || e) }; }
  if (!res.ok) return { slug, error: `HTTP ${res.status}` };
  const html = await res.text();

  // Primary source: the schema.org JSON-LD block. It is generated server-side
  // for every cluster and is bulletproof — headline, description, dates,
  // and the full author list (with sameAs links to X handles) are guaranteed.
  const ld = extractJsonLd(html);

  // Fallbacks if JSON-LD is missing (defensive, shouldn't normally trigger):
  const ogTitle = stringFromMeta(html, "og:title") || stringFromTitleTag(html);
  const ogDesc  = stringFromMeta(html, "og:description");

  // Secondary source: the RSC payload — supplies snapshots, sentiment
  // percentages, totals, caveats, etc. The story page renders fine without
  // any of these fields, so we never fail just because the RSC stream is
  // shaped unusually.
  let flight = "";
  try { flight = extractFlightText(html); } catch {}

  const story = {
    slug,
    headline:
      (ld && stripDiggSuffix(ld.headline))
      || stringAfter(flight, "headline")
      || stripDiggSuffix(ogTitle)
      || null,
    description:  ld?.description || ogDesc || null,
    summary:      stringAfter(flight, "summary") || ld?.description || null,
    oneSentence:  stringAfter(flight, "oneSentence")
                  || stringAfter(flight, "one_sentence")
                  || stringAfter(flight, "tldr")
                  || stringAfter(flight, "classification_tldr"),
    generatedAt:  stringAfter(flight, "generatedAt"),
    datePublished: ld?.datePublished || stringAfter(flight, "datePublished"),
    dateModified:  ld?.dateModified  || stringAfter(flight, "dateModified"),

    postCount:    numberAfter(flight, "postCount") || numberAfter(flight, "sourcePostCount"),
    commentCount: numberAfter(flight, "commentCount"),
    commentsAnalyzedCount:      numberAfter(flight, "commentsAnalyzedCount"),
    distinctCommentAuthorCount: numberAfter(flight, "distinctCommentAuthorCount"),
    snapshotCount: numberAfter(flight, "snapshotCount"),

    sentiment:                stringAfter(flight, "sentiment"),
    sentimentPercentages:     objectAfter(flight, "sentimentPercentages"),
    storyWeightedPercentages: objectAfter(flight, "storyWeightedPercentages"),
    userWeightedPercentages:  objectAfter(flight, "userWeightedPercentages"),
    guardedPercentages:       objectAfter(flight, "guardedPercentages"),
    confidence:   numberAfter(flight, "confidence"),
    totals:       objectAfter(flight, "totals"),
    caveats:      stringArrayAfter(flight, "caveats"),
    diggUrl:      `${ORIGIN}/ai/${encodeURIComponent(slug)}`
  };

  // Snapshots: each entry has
  //   { bucket_start, impression_count, like_count, retweet_count, reply_count, bookmark_count, quote_count }
  const snapshots = arrayAfter(flight, "snapshots");
  if (Array.isArray(snapshots)) {
    story.snapshots = snapshots
      .filter((x) => x && x.bucket_start)
      .sort((a, b) => String(a.bucket_start).localeCompare(String(b.bucket_start)));
  } else story.snapshots = [];

  // Posts: prefer the RSC payload (has post_x_id, author_category, ranks).
  // Fall back to JSON-LD author list when the RSC stream is incomplete.
  let posts = extractPosts(flight).slice(0, 30);
  if (!posts.length && ld && Array.isArray(ld.author)) {
    posts = ld.author.map((a) => ({
      author_display_name: a.name,
      author_username:    extractXHandle(a),
      post_x_id:          null,
      post_type:          null
    })).filter((p) => p.author_username);
  }

  // Post content / type isn't in the RSC stream — it's only baked into the
  // server-rendered HTML. Scan the HTML for each post's rendered card and
  // merge content + type back onto the post records.
  const renderedById = extractRenderedPostsByXId(html);
  const renderedByHandle = new Map();
  for (const r of renderedById.values()) {
    if (!renderedByHandle.has(r.handle.toLowerCase())) {
      renderedByHandle.set(r.handle.toLowerCase(), r);
    }
  }
  for (const p of posts) {
    const r = (p.post_x_id && renderedById.get(p.post_x_id))
           || (p.author_username && renderedByHandle.get(p.author_username.toLowerCase()));
    if (!r) continue;
    if (!p.content)   p.content   = r.content;
    if (!p.post_type && r.post_type) p.post_type = r.post_type;
    if (!p.post_x_id && r.post_x_id) p.post_x_id = r.post_x_id;
  }

  // If we found rendered posts the RSC stream didn't know about (rare), add
  // them too so the user sees every post the page displays.
  const have = new Set(posts.map((p) => p.post_x_id).filter(Boolean));
  for (const r of renderedById.values()) {
    if (have.has(r.post_x_id)) continue;
    posts.push({
      post_x_id: r.post_x_id,
      author_username: r.handle,
      content: r.content,
      post_type: r.post_type
    });
  }

  story.posts = posts;

  await cacheSet(key, story, TTL.story);
  return story;
}

// ---------- HTML helpers (no DOMParser in service workers) ----------
function extractJsonLd(html) {
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m, found = null;
  while ((m = re.exec(html)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      // The cluster's NewsArticle block — distinguish from other ld+json (BreadcrumbList, etc.)
      const type = Array.isArray(obj) ? obj[0]?.["@type"] : obj["@type"];
      const candidate = Array.isArray(obj) ? obj.find((o) => o["@type"] === "NewsArticle") : obj;
      if (candidate && (candidate["@type"] === "NewsArticle" || candidate.headline)) return candidate;
      if (type === "NewsArticle") return obj;
      if (!found && candidate?.headline) found = candidate;
    } catch {}
  }
  return found;
}
function stringFromMeta(html, prop) {
  const re = new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i");
  const m = re.exec(html);
  return m ? decodeEntities(m[1]) : null;
}
function stringFromTitleTag(html) {
  const m = /<title>([^<]+)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]) : null;
}
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
function stripDiggSuffix(s) {
  if (!s) return s;
  return s.replace(/\s*[·•]\s*Digg\s*$/, "").trim();
}
// Walk the cluster HTML and extract each rendered post card. Each card
// contains an `<a href="https://x.com/{handle}/status/{id}">` link followed
// (shortly after, within the same card) by one or more `<p class="…
// whitespace-pre-wrap …">content</p>` paragraphs. We concatenate the <p>s
// found within ~6 KB of the status URL and stop at the next status URL
// (which is a different post's card).
function extractRenderedPostsByXId(html) {
  const out = new Map();
  const statusRe = /https?:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/g;
  const indices = [];
  let m;
  while ((m = statusRe.exec(html)) !== null) {
    indices.push({ idx: m.index, end: m.index + m[0].length, handle: m[1], id: m[2] });
  }
  // For each status URL, look in the slice between its end and the next
  // status URL's start. Pull all whitespace-pre-wrap <p> paragraphs from
  // that slice and merge them as the post's content.
  for (let i = 0; i < indices.length; i++) {
    const here = indices[i];
    const next = indices[i + 1];
    if (out.has(here.id)) continue; // already captured
    const sliceEnd = next ? Math.min(next.idx, here.end + 8000) : Math.min(here.end + 8000, html.length);
    const slice = html.slice(here.end, sliceEnd);
    const content = extractWhitespacePreParagraphs(slice);
    if (!content) continue;
    out.set(here.id, {
      post_x_id: here.id,
      handle: here.handle,
      content,
      post_type: detectPostType(slice)
    });
  }
  return out;
}

function extractWhitespacePreParagraphs(htmlSlice) {
  // Grab <p class="…whitespace-pre-wrap…">…</p> blocks. Multiple paragraphs
  // get joined with blank lines so the original line breaks survive.
  const re = /<p\b[^>]*class="[^"]*whitespace-pre-wrap[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
  const parts = [];
  let m;
  while ((m = re.exec(htmlSlice)) !== null) {
    const txt = stripTagsAndDecode(m[1]).trim();
    if (txt) parts.push(txt);
    if (parts.length >= 6) break;
  }
  return parts.length ? parts.join("\n\n") : "";
}

function stripTagsAndDecode(s) {
  return decodeEntities(
    String(s)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  );
}

function detectPostType(htmlSlice) {
  // Card headers stamp a pill: "QUOTE POST", "REPLY", "RETWEET", "ORIGINAL".
  // We match the first one that appears.
  const m = /(QUOTE POST|REPLY|RETWEET|ORIGINAL)/.exec(htmlSlice);
  if (!m) return null;
  return m[1].toLowerCase().replace(" post", "");
}

function extractXHandle(authorObj) {
  if (!authorObj) return null;
  const same = authorObj.sameAs;
  const arr = Array.isArray(same) ? same : (same ? [same] : []);
  for (const url of arr) {
    const m = /(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/.exec(String(url));
    if (m) return m[1];
  }
  return null;
}

function extractPosts(text) {
  const out = [];
  const seen = new Set();
  const re = /"post_x_id":"([^"]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (seen.has(m[1])) continue;
    let depth = 0, i = m.index;
    while (i > 0) {
      const c = text[i];
      if (c === "}") depth++;
      else if (c === "{") {
        if (depth === 0) break;
        depth--;
      }
      i--;
    }
    if (text[i] !== "{") continue;
    const r = readJsonObject(text, i);
    if (!r) continue;
    const obj = r[1];
    if (!obj.post_x_id) continue;
    seen.add(obj.post_x_id);
    out.push(obj);
    if (out.length > 40) break;
  }
  return out;
}

// ---------- feed ----------
async function getDiggFeed() {
  const key = "feed:top";
  const cached = await cacheGet(key);
  if (cached) return cached;

  let res;
  try { res = await fetchWithTimeout(`${ORIGIN}/ai`); }
  catch (e) { return { stories: [], trending: {}, error: String(e) }; }
  if (!res.ok) return { stories: [], trending: {}, error: `HTTP ${res.status}` };
  const html = await res.text();
  const flight = extractFlightText(html);

  const stories = [];
  const anchor = flight.indexOf('"storiesByFilter"');
  if (anchor >= 0) {
    const itemsKey = '"items":[';
    const itemsAt = flight.indexOf(itemsKey, anchor);
    if (itemsAt >= 0) {
      let i = itemsAt + itemsKey.length;
      while (i < flight.length && flight[i] !== "]") {
        while (i < flight.length && (flight[i] === "," || flight[i] === " " || flight[i] === "\n")) i++;
        if (flight[i] !== "{") break;
        const r = readJsonObject(flight, i);
        if (!r) break;
        stories.push(r[1]);
        i = r[0];
        if (stories.length > 60) break;
      }
    }
  }

  const trending = {
    storiesToday:         numberAfter(flight, "storiesToday"),
    clustersToday:        numberAfter(flight, "clustersToday"),
    lastFetchCompletedAt: stringAfter(flight, "lastFetchCompletedAt")
  };

  const out = { stories, trending, fetchedAt: Date.now() };
  await cacheSet(key, out, TTL.feed);
  return out;
}

async function getTrendingStatus() {
  const key = "trending:status";
  const cached = await cacheGet(key);
  if (cached) return cached;
  let res;
  try { res = await fetchWithTimeout(`${ORIGIN}/api/trending/status`, { cache: "no-store" }); }
  catch { return null; }
  if (!res.ok) return null;
  const json = await res.json();
  await cacheSet(key, json, TTL.trending);
  return json;
}

async function searchDigg(kind, q, limit) {
  if (!q || q.length < 2) return { results: [] };
  const lim = limit || (kind === "users" ? 12 : 8);
  const key = `search:${kind}:${q.toLowerCase()}:${lim}`;
  const cached = await cacheGet(key);
  if (cached) return cached;
  const params = new URLSearchParams({ q, limit: String(lim) });
  let res;
  try { res = await fetchWithTimeout(`${ORIGIN}/api/search/${kind}?${params.toString()}`); }
  catch { return { results: [] }; }
  if (!res.ok) return { results: [] };
  const json = await res.json();
  await cacheSet(key, json, TTL.search);
  return json;
}

// ---------- message bus ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      let data;
      switch (msg.type) {
        case "digg:profile":  data = await getDiggProfile(msg.username); break;
        case "digg:feed":     data = await getDiggFeed(); break;
        case "digg:trending": data = await getTrendingStatus(); break;
        case "digg:search":   data = await searchDigg(msg.kind, msg.q, msg.limit); break;
        case "digg:story":    data = await getDiggStory(msg.slug); break;
        default:              sendResponse({ ok: false, error: "unknown message type" }); return;
      }
      sendResponse({ ok: true, data });
    } catch (e) {
      console.warn("[digg-bg] handler error", msg, e);
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // async response
});
