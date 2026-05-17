// Digg panel — list views (Trending / Search / Status) + in-place story reader.
// Story reader includes engagement sparklines, multi-mode sentiment, caveats,
// and a posts list. Clicking story anywhere routes here via postMessage so
// the user never has to leave X to read a Digg story.

const ICONS = window.DIGG_ICONS;
const DIGG = "https://digg.com";

document.getElementById("brand-wordmark").innerHTML = ICONS.wordmark;
document.getElementById("close").innerHTML = ICONS.close;
document.getElementById("back").innerHTML = ICONS.arrow;
document.getElementById("back").style.transform = "rotate(180deg)";

document.getElementById("close").addEventListener("click", () => {
  parent.postMessage({ source: "digg-panel", type: "close" }, "*");
});

// Robust message bridge. Two failure modes to handle:
//   1. Synchronous throw — `chrome.runtime.sendMessage` throws if the
//      extension context is already invalidated before the call.
//   2. Unhandled promise rejection — MV3's `sendMessage` ALSO returns a
//      thenable that rejects when the call can't complete (port closed,
//      context invalidated). If we pass a callback we still get both the
//      callback AND a rejected promise; that's where the
//      "Uncaught (in promise) Error: Extension context invalidated."
//      messages were coming from.
// Using the promise form with await + try/catch handles both cleanly.
let contextInvalidated = false;
async function send(msg) {
  if (contextInvalidated || !chrome.runtime?.id) {
    return { ok: false, error: "context-invalidated" };
  }
  try {
    const resp = await chrome.runtime.sendMessage(msg);
    return resp ?? { ok: false, error: "no-response" };
  } catch (e) {
    const err = String(e?.message || e);
    if (/context invalidated|disconnected port|Extension context|message port closed/i.test(err)) {
      contextInvalidated = true;
      showReloadBanner();
      return { ok: false, error: "context-invalidated" };
    }
    return { ok: false, error: err };
  }
}

function showReloadBanner() {
  if (document.getElementById("digg-reload-banner")) return;
  const div = document.createElement("div");
  div.id = "digg-reload-banner";
  div.innerHTML = `
    <div style="position:sticky;top:0;z-index:10;padding:10px 16px;background:rgb(56, 21, 21);border-bottom:1px solid rgb(244,33,46);color:#fff;font-size:13px;display:flex;align-items:center;gap:8px">
      <span style="flex:1">Digg extension was reloaded. Refresh X to reconnect.</span>
      <button type="button" id="digg-reload-btn" style="background:#fff;color:#000;border:0;padding:4px 12px;border-radius:9999px;font-weight:700;cursor:pointer">Refresh</button>
    </div>`;
  document.body.insertBefore(div, document.body.firstChild);
  document.getElementById("digg-reload-btn").addEventListener("click", () => {
    try { window.top.location.reload(); }
    catch { parent.postMessage({ source: "digg-panel", type: "reload-host" }, "*"); }
  });
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function formatCount(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ============================================================
// Router
// ============================================================
const state = { view: "trending", storySlug: null, storyData: null, fromView: "trending" };

function setView(name) {
  state.view = name;
  document.querySelectorAll(".view").forEach((v) => v.dataset.active = (v.id === `view-${name}`).toString());
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", (t.dataset.tab === name).toString()));
  document.getElementById("tabs").hidden = name === "story";
  document.getElementById("back").hidden = name !== "story";
  const footerLink = document.getElementById("footer-link");
  if (name === "story") {
    footerLink.href = state.storyData?.diggUrl || (state.storySlug ? `${DIGG}/ai/${encodeURIComponent(state.storySlug)}` : `${DIGG}/ai`);
    footerLink.textContent = "Open this story on digg.com →";
  } else {
    footerLink.href = `${DIGG}/ai`;
    footerLink.textContent = "Open digg.com →";
  }
  if (name === "status") loadStatus();
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => setView(tab.dataset.tab)));
document.getElementById("back").addEventListener("click", () => setView(state.fromView || "trending"));

window.addEventListener("message", (e) => {
  if (!e.data || e.data.source !== "digg-host") return;
  if (e.data.type === "navigate") {
    if (e.data.view === "story" && e.data.slug) openStory(e.data.slug);
    else if (e.data.view) setView(e.data.view);
  }
});
parent.postMessage({ source: "digg-panel", type: "ready" }, "*");

// ============================================================
// Trending
// ============================================================
async function loadTrending() {
  const resp = await send({ type: "digg:feed" });
  const stories = (resp?.data?.stories || []);
  const trending = resp?.data?.trending || {};

  document.getElementById("stat-bar").innerHTML = [
    typeof trending.storiesToday === "number"  ? `<span><strong>${trending.storiesToday}</strong> stories today</span>` : "",
    typeof trending.clustersToday === "number" ? `<span><strong>${trending.clustersToday}</strong> clusters</span>` : "",
    trending.lastFetchCompletedAt              ? `<span>updated ${escapeHtml(timeAgo(trending.lastFetchCompletedAt))}</span>` : ""
  ].join("");

  const list = document.getElementById("stories");
  document.getElementById("trending-empty").hidden = stories.length > 0;
  list.innerHTML = stories.map((s, i) => storyListItem(s, i)).join("");
  list.querySelectorAll("button[data-slug]").forEach((btn) => {
    btn.addEventListener("click", () => openStory(btn.dataset.slug));
  });
}

function storyListItem(s, i) {
  const slug = s.clusterUrlId || s.shortId || "";
  const meta = [
    `#${s.rank ?? i + 1}`,
    typeof s.postCount === "number" ? `${s.postCount} posts` : null,
    s.createdAt ? timeAgo(s.createdAt) : null
  ].filter(Boolean).join(" · ");
  const authors = (s.authors || []).slice(0, 5).map((a) =>
    a.avatarUrl ? `<img src="${escapeHtml(a.avatarUrl)}" alt="${escapeHtml(a.displayName || a.username || "")}" title="@${escapeHtml(a.username || "")}">` : ""
  ).join("");
  return `<li><button type="button" data-slug="${escapeHtml(slug)}">
    <div class="story-meta"><span class="story-rank">${escapeHtml(meta)}</span></div>
    <div class="story-title">${escapeHtml(s.title || s.headline || "")}</div>
    <div class="story-tldr">${escapeHtml(s.tldr || s.summary || s.oneSentence || "")}</div>
    ${authors ? `<div class="story-authors">${authors}</div>` : ""}
  </button></li>`;
}

// ============================================================
// Search
// ============================================================
let searchKind = "stories", searchTimer = null;
document.querySelectorAll(".kind").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".kind").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    searchKind = b.dataset.kind;
    runSearch();
  });
});
document.getElementById("search-input").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 180);
});
async function runSearch() {
  const q = document.getElementById("search-input").value.trim();
  const empty = document.getElementById("search-empty");
  const list = document.getElementById("search-results");
  if (!q) { empty.hidden = false; empty.textContent = "Start typing to search."; list.innerHTML = ""; return; }
  const resp = await send({ type: "digg:search", kind: searchKind, q });
  const results = resp?.data?.results || [];
  if (!results.length) { empty.hidden = false; empty.textContent = "No matches."; list.innerHTML = ""; return; }
  empty.hidden = true;
  list.innerHTML = results.map((r) => searchRow(r, searchKind)).join("");
  list.querySelectorAll("button[data-slug]").forEach((btn) => {
    btn.addEventListener("click", () => openStory(btn.dataset.slug));
  });
}
function searchRow(r, kind) {
  if (kind === "users") {
    // Clicking a search-people result navigates X to the user's profile —
    // our content script will then enrich it with the Digg card.
    return `<li><a href="https://x.com/${encodeURIComponent(r.username || "")}" target="_top" rel="noopener">
      <div class="user-row">
        ${r.profile_image_url ? `<div class="ua" style="background-image:url('${escapeHtml(r.profile_image_url)}')"></div>` : `<div class="ua"></div>`}
        <div>
          <div class="u-name">${escapeHtml(r.display_name || r.username || "")}</div>
          <div class="u-meta">@${escapeHtml(r.username || "")} · ${escapeHtml(formatCount(r.followers_count))} followers</div>
        </div>
      </div>
    </a></li>`;
  }
  if (kind === "repos") {
    return `<li><a href="https://github.com/${encodeURIComponent(r.full_name || "")}" target="_blank" rel="noopener">
      <div class="story-title">${escapeHtml(r.full_name || r.name || "")}</div>
      <div class="story-tldr">⭐ ${escapeHtml(formatCount(r.stargazers_count))} · ${escapeHtml(r.description || "")}</div>
    </a></li>`;
  }
  return storyListItem(r, 0);
}

// ============================================================
// Status
// ============================================================
async function loadStatus() {
  const resp = await send({ type: "digg:trending" });
  document.getElementById("status-json").textContent = JSON.stringify(resp?.data || resp, null, 2);
}

// ============================================================
// Sparkline (inline SVG, currentColor)
// ============================================================
function sparkline(values, { width = 100, height = 28, accent = "var(--accent)" } = {}) {
  const arr = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (arr.length < 2) return "";
  const max = Math.max(...arr);
  const min = Math.min(...arr);
  const range = Math.max(1, max - min);
  const step = width / (arr.length - 1);
  const pts = arr.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`);
  const linePath = `M${pts.join(" L")}`;
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="width:100%;height:${height}px;display:block">
    <path d="${areaPath}" fill="${accent}" opacity="0.15"/>
    <path d="${linePath}" stroke="${accent}" stroke-width="1.5" fill="none" stroke-linejoin="round"/>
  </svg>`;
}

// ============================================================
// Story detail view
// ============================================================
async function openStory(slug) {
  if (!slug) return;
  state.fromView = state.view === "story" ? state.fromView : state.view;
  state.storySlug = slug;
  state.storyData = null;
  setView("story");

  const el = document.getElementById("story-content");
  el.innerHTML = `<div class="empty">Loading story…</div>`;

  const resp = await send({ type: "digg:story", slug });
  if (state.storySlug !== slug) return;
  const story = resp?.data;

  // Only treat as "failed" if we got NOTHING back. Even a story with just a
  // headline + author list (no engagement / sentiment) is worth showing.
  const hasAnything = story && (story.headline || story.description || (story.posts && story.posts.length));
  if (!hasAnything) {
    const errMsg = story?.error || resp?.error || "We couldn't reach digg.com.";
    el.innerHTML = `<div class="empty">
      <div style="margin-bottom:12px">Couldn't load this story.</div>
      <div style="margin-bottom:16px;font-size:12px">${escapeHtml(errMsg)}</div>
      <button class="kind active" id="retry-story">Retry</button>
      <a href="${DIGG}/ai/${encodeURIComponent(slug)}" target="_blank" rel="noopener" style="display:inline-block;margin-left:8px;color:var(--accent);text-decoration:none">Open on digg.com →</a>
    </div>`;
    document.getElementById("retry-story")?.addEventListener("click", () => openStory(slug));
    return;
  }
  state.storyData = story;
  el.innerHTML = renderStory(story);
  document.getElementById("footer-link").href = story.diggUrl || `${DIGG}/ai/${encodeURIComponent(slug)}`;

  // Wire interactions in the rendered story.
  el.querySelectorAll('button[data-sentiment-mode]').forEach((btn) => {
    btn.addEventListener("click", () => {
      el.querySelectorAll('button[data-sentiment-mode]').forEach((b) => b.classList.toggle("active", b === btn));
      renderSentimentBar(story, btn.dataset.sentimentMode, el);
    });
  });
  el.querySelectorAll("a[data-x-handle]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      parent.postMessage({ source: "digg-panel", type: "close" }, "*");
      window.top.location.href = `https://x.com/${encodeURIComponent(a.dataset.xHandle)}`;
    });
  });
}

function renderStory(s) {
  const meta = [
    s.datePublished || s.generatedAt ? timeAgo(s.datePublished || s.generatedAt) : null,
    typeof s.postCount === "number" ? `${s.postCount} posts` : null,
    typeof s.commentsAnalyzedCount === "number" ? `${s.commentsAnalyzedCount} comments analyzed` : null,
    typeof s.confidence === "number" ? `${Math.round(s.confidence * 100)}% confidence` : null
  ].filter(Boolean).join(" · ");

  const title = s.headline || s.description || "Untitled story";
  return `
    <div class="story-head">
      <div class="story-meta"><span class="story-rank">${escapeHtml(meta || "Story")}</span></div>
      <h1>${escapeHtml(title)}</h1>
    </div>
    ${s.oneSentence ? `<div class="story-tldr-block">${escapeHtml(s.oneSentence)}</div>` : ""}
    ${s.summary && s.summary !== s.oneSentence && s.summary !== s.description ? `<div class="story-summary">${escapeHtml(s.summary)}</div>` : ""}
    ${(!s.summary || s.summary === s.oneSentence) && s.description && s.description !== title ? `<div class="story-summary">${escapeHtml(s.description)}</div>` : ""}

    ${renderEngagement(s)}
    ${renderSentimentSection(s)}
    ${renderCaveats(s)}
    ${renderPostsList(s)}
  `;
}

// ----- Cluster engagement (sparklines from snapshots) -----
function renderEngagement(s) {
  const snaps = s.snapshots || [];
  const t = s.totals || {};

  // For each metric, build the series. The snapshot stores cumulative counts;
  // we plot cumulative directly so the line "grows" with the story.
  const series = (key) => snaps.map((x) => Number(x[key]) || 0);
  const last = (key) => {
    const arr = series(key);
    return arr.length ? arr[arr.length - 1] : null;
  };

  const tiles = [
    { label: "Views",     key: "impression_count", total: t.total_impressions ?? last("impression_count"), color: "rgb(0, 186, 124)"  },
    { label: "Comments",  key: "reply_count",      total: t.total_replies     ?? last("reply_count"),      color: "rgb(29, 155, 240)" },
    { label: "Reposts",   key: "retweet_count",    total: t.total_retweets    ?? last("retweet_count"),    color: "rgb(120, 86, 255)" },
    { label: "Bookmarks", key: "bookmark_count",   total: t.total_bookmarks   ?? last("bookmark_count"),   color: "rgb(255, 184, 0)"  }
  ];

  // Only show the section if we have something to plot.
  if (!snaps.length && !tiles.some((x) => typeof x.total === "number" && x.total > 0)) return "";

  const tileHtml = tiles.map((tile) => `
    <div class="metric-tile" style="--metric-color:${tile.color}">
      <div class="metric-label">${tile.label}</div>
      <div class="metric-value">${typeof tile.total === "number" ? formatCount(tile.total) : "—"}</div>
      <div class="metric-spark">${sparkline(series(tile.key), { accent: tile.color })}</div>
    </div>`).join("");

  return `
    <div class="section-label">Cluster engagement
      ${typeof s.snapshotCount === "number" ? `<span class="section-aside">${s.snapshotCount} snapshots</span>` : ""}
    </div>
    <div class="metric-grid">${tileHtml}</div>
  `;
}

// ----- Sentiment (positive/negative/neutral, four weighting modes) -----
function renderSentimentSection(s) {
  const modes = [
    { key: "sentimentPercentages",     label: "Raw" },
    { key: "storyWeightedPercentages", label: "Story-weighted" },
    { key: "userWeightedPercentages",  label: "User-weighted" },
    { key: "guardedPercentages",       label: "Guarded" }
  ].filter((m) => s[m.key] && Object.keys(s[m.key]).length);
  if (!modes.length) return "";
  const initial = modes[0].key;

  return `
    <div class="section-label">Sentiment
      ${typeof s.commentsAnalyzedCount === "number" ? `<span class="section-aside">${s.commentsAnalyzedCount} comments analyzed${typeof s.distinctCommentAuthorCount === "number" ? ` · ${s.distinctCommentAuthorCount} authors` : ""}</span>` : ""}
    </div>
    <div class="sentiment-tabs">
      ${modes.map((m, i) =>
        `<button type="button" data-sentiment-mode="${m.key}" class="kind ${i === 0 ? "active" : ""}">${m.label}</button>`
      ).join("")}
    </div>
    <div id="sentiment-bar-host">${sentimentBarHtml(s[initial])}</div>
  `;
}

function renderSentimentBar(s, modeKey, el) {
  const host = el.querySelector("#sentiment-bar-host");
  if (host) host.innerHTML = sentimentBarHtml(s[modeKey]);
}

function sentimentBarHtml(p) {
  if (!p) return "";
  const pos = Number(p.positive) || 0;
  const neg = Number(p.negative) || 0;
  const neu = Math.max(0, 100 - pos - neg);
  return `
    <div class="sentiment-bar">
      <span class="pos" style="width:${pos}%"></span>
      <span class="neu" style="width:${neu}%"></span>
      <span class="neg" style="width:${neg}%"></span>
    </div>
    <div class="sentiment-legend">
      <span><strong>${pos.toFixed(0)}%</strong>positive</span>
      <span><strong>${neu.toFixed(0)}%</strong>neutral</span>
      <span><strong>${neg.toFixed(0)}%</strong>negative</span>
    </div>
  `;
}

// ----- Analysis caveats -----
function renderCaveats(s) {
  if (!s.caveats || !s.caveats.length) return "";
  // Filter out diagnostic tags like "high_discard_rate" — non-prose noise.
  const human = s.caveats.filter((c) => /\s/.test(c) && c.length > 8);
  if (!human.length) return "";
  return `
    <div class="section-label">Analysis caveats</div>
    <ul class="caveats">
      ${human.slice(0, 8).map((c) => `<li>${escapeHtml(c)}</li>`).join("")}
    </ul>`;
}

// ----- Posts in this cluster -----
function renderPostsList(s) {
  if (!s.posts || !s.posts.length) return "";
  // Posts already sorted by Digg (highest ranked authors first).
  return `
    <div class="section-label">Posts in this story
      <span class="section-aside">${s.posts.length}</span>
    </div>
    ${s.posts.slice(0, 15).map(renderPost).join("")}
  `;
}

function renderPost(p) {
  const handle  = p.author_username || p.author?.username || "";
  const display = p.author_display_name || p.author?.display_name || handle;
  const avatar  = p.author_profile_image_url || p.author?.profile_image_url || p.author?.avatar_url || "";
  const cat     = p.author_category || p.author?.category || "";
  const rank    = p.author_rank;
  const xUrl    = handle && p.post_x_id ? `https://x.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(p.post_x_id)}` : null;
  const postType = (p.post_type || "").toLowerCase();
  const typeIcon = ({ reply: "↳", quote: "❝", retweet: "↻", original: "•" })[postType] || "";
  const engagement = [
    ["♡", p.like_count],
    ["↻", p.retweet_count],
    ["✦", p.reply_count],
    ["⌖", p.bookmark_count]
  ].filter(([, v]) => typeof v === "number" && v > 0);

  return `<div class="post">
    <div class="post-head">
      ${avatar ? `<div class="post-avatar" style="background-image:url('${escapeHtml(avatar)}')"></div>` : `<div class="post-avatar"></div>`}
      <div class="post-id">
        <div class="post-name">${escapeHtml(display)}
          ${cat ? `<span class="post-cat">${escapeHtml(cat)}</span>` : ""}
        </div>
        <div class="post-handle">
          ${handle ? `<a data-x-handle="${escapeHtml(handle)}" href="https://x.com/${escapeHtml(handle)}">@${escapeHtml(handle)}</a>` : ""}
          ${typeof rank === "number" ? ` · #${rank}` : ""}
          ${typeIcon ? ` · ${typeIcon} ${escapeHtml(postType)}` : ""}
          ${p.posted_at ? ` · ${escapeHtml(timeAgo(p.posted_at))}` : ""}
        </div>
      </div>
    </div>
    ${p.content ? `<div class="post-content">${escapeHtml(p.content)}</div>` : ""}
    ${engagement.length ? `<div class="post-engagement">${engagement.map(([s, v]) => `<span>${s} ${formatCount(v)}</span>`).join("")}</div>` : ""}
    ${xUrl ? `<a class="post-link" href="${xUrl}" target="_top">Open on X →</a>` : ""}
  </div>`;
}

// ============================================================
// Boot
// ============================================================
loadTrending();
setInterval(() => { if (state.view === "trending") loadTrending(); }, 60_000);
