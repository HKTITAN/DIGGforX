// Digg for X — DOM integration on x.com / twitter.com.
//
// Injection points:
//   1. "Digg" tab in the left AppTabBar (mark + wordmark + today-count badge).
//   2. Slide-out panel (iframe → ui/panel.html) — trending feed, search, story reader.
//   3. Profile card mounted right above the Posts/Replies tablist on /{handle}.
//      Shows AI Classification, Category, Gravity/Top Followers/Followers as
//      X-style stats, Vibe & Topic chips, and stories that feature this user.
//   4. Inline DIGG · {Category} badges next to UserCells.
//   5. "Trending on Digg" widget in the right column. Click a story → opens
//      it inside the panel (no leaving X).

const ICONS = window.DIGG_ICONS;
const DIGG_HOST = "https://digg.com";

const RESERVED_PATHS = new Set([
  "home", "explore", "notifications", "messages", "bookmarks", "lists",
  "communities", "premium_sign_up", "verified-choose", "i", "settings",
  "search", "compose", "tos", "privacy", "logout", "login", "signup",
  "topics", "moments", "jobs", "grok", "search-advanced", "hashtag",
  "share", "intent", "explore", "premium"
]);

function currentProfileHandle() {
  const segs = location.pathname.split("/").filter(Boolean);
  if (!segs.length) return null;
  const first = segs[0].toLowerCase();
  if (RESERVED_PATHS.has(first)) return null;
  if (segs[1] === "status") return null;
  return segs[0];
}

// Robust message bridge — see panel.js for the full rationale. MV3's
// sendMessage rejects its returned Promise on context invalidation even
// when a callback is supplied; awaiting it with try/catch handles both
// failure modes without leaking unhandled rejections to the console.
let runtimeAlive = true;
async function sendMessage(msg) {
  if (!runtimeAlive || !chrome.runtime?.id) {
    return { ok: false, error: "context-invalidated" };
  }
  try {
    const resp = await chrome.runtime.sendMessage(msg);
    return resp ?? { ok: false, error: "no-response" };
  } catch (e) {
    const err = String(e?.message || e);
    if (/context invalidated|disconnected port|Extension context|message port closed/i.test(err)) {
      killRuntime();
      return { ok: false, error: "context-invalidated" };
    }
    return { ok: false, error: err };
  }
}

function killRuntime() {
  if (!runtimeAlive) return;
  runtimeAlive = false;
  try { obs?.disconnect?.(); } catch {}
  // Hide any half-rendered loading cards so the user isn't stuck staring at
  // "looking up @…" — they're useless without the background.
  document.querySelectorAll(".digg-profile-card.is-loading").forEach((c) => c.remove());
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ============================================================
//  Slide-out panel
// ============================================================
let panelEl = null;
let overlayEl = null;
let panelIframe = null;

function ensurePanel() {
  if (panelEl) return panelEl;
  overlayEl = document.createElement("div");
  overlayEl.className = "digg-overlay";
  overlayEl.addEventListener("click", () => closePanel());
  document.body.appendChild(overlayEl);

  panelEl = document.createElement("aside");
  panelEl.className = "digg-panel";
  panelIframe = document.createElement("iframe");
  panelIframe.src = chrome.runtime.getURL("ui/panel.html");
  panelIframe.title = "Digg";
  panelEl.appendChild(panelIframe);
  document.body.appendChild(panelEl);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panelEl.dataset.open === "true") closePanel();
  });
  return panelEl;
}

function openPanel(routeMsg) {
  ensurePanel();
  panelEl.dataset.open = "true";
  overlayEl.dataset.open = "true";
  document.documentElement.style.overflow = "hidden";
  if (routeMsg) {
    // Wait until the iframe finishes loading before posting nav messages.
    const post = () => panelIframe.contentWindow?.postMessage(routeMsg, "*");
    if (panelIframe.dataset.ready === "true") post();
    else panelIframe.addEventListener("load", post, { once: true });
  }
}
function closePanel() {
  if (!panelEl) return;
  panelEl.dataset.open = "false";
  overlayEl.dataset.open = "false";
  document.documentElement.style.overflow = "";
}

window.addEventListener("message", (e) => {
  if (!e.data || e.data.source !== "digg-panel") return;
  if (e.data.type === "close") closePanel();
  if (e.data.type === "ready") panelIframe.dataset.ready = "true";
  if (e.data.type === "reload-host") location.reload();
});

// ============================================================
//  Sidebar tab
// ============================================================
function injectSidebarTab() {
  const anchor =
    document.querySelector('a[data-testid="AppTabBar_Notifications_Link"]') ||
    document.querySelector('a[data-testid="AppTabBar_Explore_Link"]') ||
    document.querySelector('a[data-testid="AppTabBar_Home_Link"]');
  if (!anchor) return false;
  if (document.querySelector('a[data-testid="AppTabBar_Digg_Link"]')) return true;

  const link = document.createElement("a");
  link.href = "#digg";
  link.className = "digg-sidenav-link";
  link.setAttribute("role", "link");
  link.setAttribute("data-testid", "AppTabBar_Digg_Link");
  link.setAttribute("aria-label", "Digg");
  link.innerHTML = `
    <span class="digg-sidenav-icon">${ICONS.mark}</span>
    <span class="digg-sidenav-label">${ICONS.wordmark}</span>
    <span class="digg-sidenav-badge" data-role="badge"></span>
  `;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    openPanel({ source: "digg-host", type: "navigate", view: "trending" });
  });
  anchor.insertAdjacentElement("afterend", link);

  updateTrendingBadge(link.querySelector('[data-role="badge"]'));
  setInterval(() => updateTrendingBadge(link.querySelector('[data-role="badge"]')), 60_000);
  return true;
}

async function updateTrendingBadge(el) {
  if (!el) return;
  const resp = await sendMessage({ type: "digg:trending" });
  if (!resp || !resp.ok || !resp.data) { el.style.display = "none"; return; }
  const n = resp.data.storiesToday ?? resp.data.clustersToday;
  if (typeof n !== "number" || n <= 0) { el.style.display = "none"; return; }
  el.textContent = String(n);
  el.style.display = "";
}

// ============================================================
//  Profile-page card
// ============================================================
let lastEnrichedHandle = null;

function findProfileTablist() {
  // The Posts / Replies / Subs / Highlights / Articles / Media tablist —
  // a stable anchor that sits below all the profile-header rows.
  const lists = document.querySelectorAll('[role="tablist"][data-testid="ScrollSnap-List"]');
  for (const tl of lists) {
    if (tl.closest('[data-testid="primaryColumn"]')) return tl;
  }
  return null;
}

function findProfileCardAnchor() {
  // We insert RIGHT BEFORE the tablist's container row. Walk up the tablist
  // until we hit a div that's a direct child of the column scroller.
  const tl = findProfileTablist();
  if (!tl) return null;
  let host = tl;
  // Climb until we find a parent that is a sibling of the rest of the profile rows.
  while (host.parentElement && !host.parentElement.matches('[data-testid="primaryColumn"]')) {
    // Stop at the first row-level container. Heuristic: a div whose parent
    // contains the UserName testid as a descendant of a previous sibling.
    const p = host.parentElement;
    if (p.children.length > 1 && [...p.children].some(c => c !== host && c.querySelector?.('[data-testid="UserName"]'))) {
      return host;
    }
    host = p;
  }
  return host;
}

function renderChips(obj) {
  if (!obj) return "";
  const entries = Object.entries(obj)
    .filter(([, v]) => Number(v) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 6);
  if (!entries.length) return "";
  return `<div class="digg-chips">${entries.map(([k, v]) => {
    const pct = Number(v).toFixed(Number(v) >= 10 ? 0 : 1);
    return `<span class="digg-chip"><span class="digg-chip-label">${escapeHtml(k.replace(/_/g, " "))}</span><strong>${pct}%</strong></span>`;
  }).join("")}</div>`;
}

function renderMiniStory(s) {
  const slug = s.clusterUrlId || s.shortId || s.slug;
  if (!slug) return "";
  const meta = [
    typeof s.rank === "number" ? `#${s.rank}` : null,
    typeof s.postCount === "number" ? `${s.postCount} posts` : null
  ].filter(Boolean).join(" · ");
  return `<button type="button" class="digg-mini-story" data-story-id="${escapeHtml(slug)}">
    <div class="digg-mini-meta"><span class="digg-mini-rank">${escapeHtml(meta || "Featured")}</span></div>
    <div class="digg-mini-title">${escapeHtml(s.title || s.headline || "")}</div>
  </button>`;
}

function renderProfileCard(profile, featuredStories) {
  const url = profile.profileUrl || `${DIGG_HOST}/u/x/${encodeURIComponent(profile.username)}`;
  const cat = profile.category;
  const catHref = cat ? `${DIGG_HOST}/ai/x/rankings?tag=${cat.tag}` : null;

  const stats = [];
  if (profile.gravity)      stats.push(`<span class="digg-stat"><span class="digg-stat-value">${escapeHtml(profile.gravity)}</span> Gravity</span>`);
  if (profile.topFollowers) stats.push(`<span class="digg-stat"><span class="digg-stat-value">${escapeHtml(profile.topFollowers)}</span> Top followers</span>`);

  return `
    <div class="digg-card-head">
      <span class="digg-logo">${ICONS.wordmark}</span>
      <span class="digg-sub">on this account</span>
      <span class="digg-card-actions">
        <a class="digg-cta" href="${url}" target="_blank" rel="noopener">
          View on Digg ${ICONS.arrow}
        </a>
      </span>
    </div>

    ${stats.length ? `<div class="digg-stats">${stats.join("")}</div>` : ""}

    ${cat ? `<div class="digg-category-row">
      <a class="digg-category" href="${catHref}" target="_blank" rel="noopener">${ICONS.spark} ${escapeHtml(cat.label)}</a>
    </div>` : ""}

    ${profile.classification ? `
      <div class="digg-section-label">AI Classification</div>
      <div class="digg-classification">${escapeHtml(profile.classification)}</div>
    ` : ""}

    ${(profile.vibe || profile.topic) ? `<div class="digg-section-label">Vibe &amp; Topics</div>` : ""}
    ${renderChips(profile.vibe)}
    ${renderChips(profile.topic)}

    ${featuredStories && featuredStories.length ? `
      <div class="digg-section-label">Featured in</div>
      <div class="digg-mini-stories">
        ${featuredStories.slice(0, 3).map(renderMiniStory).join("")}
      </div>
    ` : ""}
  `;
}

async function fetchFeaturedStories(handle) {
  // Use the search-stories endpoint with the handle as the query. Filter to
  // matches that include this user as an author.
  const resp = await sendMessage({ type: "digg:search", kind: "stories", q: handle, limit: 6 });
  if (!resp?.ok) return [];
  const results = resp.data?.results || [];
  const lower = handle.toLowerCase();
  return results.filter((s) =>
    Array.isArray(s.authors) && s.authors.some((a) => (a.username || "").toLowerCase() === lower)
  );
}

async function maybeRenderProfileCard() {
  const handle = currentProfileHandle();
  if (!handle) {
    document.querySelectorAll(".digg-profile-card").forEach((n) => n.remove());
    lastEnrichedHandle = null;
    return;
  }

  const anchor = findProfileCardAnchor();
  if (!anchor) return;

  const existing = document.querySelector('.digg-profile-card');
  if (existing && existing.dataset.handle === handle.toLowerCase() && existing.previousElementSibling === anchor.previousElementSibling) {
    return; // already in place
  }
  if (existing) existing.remove();

  const card = document.createElement("section");
  card.className = "digg-profile-card is-loading";
  card.dataset.handle = handle.toLowerCase();
  card.innerHTML = `
    <div class="digg-card-head">
      <span class="digg-logo">${ICONS.wordmark}</span>
      <span class="digg-sub">looking up @${escapeHtml(handle)}…</span>
    </div>
  `;
  anchor.parentElement.insertBefore(card, anchor);
  lastEnrichedHandle = handle.toLowerCase();

  const [profileResp, featured] = await Promise.all([
    sendMessage({ type: "digg:profile", username: handle }),
    fetchFeaturedStories(handle)
  ]);

  if (lastEnrichedHandle !== handle.toLowerCase()) return;
  const profile = profileResp && profileResp.ok ? profileResp.data : null;

  // Transient error (timeout / network) — show a retry pill instead of hiding silently.
  if (!profile || profile.error) {
    card.classList.remove("is-loading");
    card.innerHTML = `
      <div class="digg-card-head">
        <span class="digg-logo">${ICONS.wordmark}</span>
        <span class="digg-sub">couldn't reach digg.com</span>
        <span class="digg-card-actions">
          <button type="button" class="digg-cta" data-action="retry">Retry</button>
        </span>
      </div>`;
    card.querySelector('[data-action="retry"]').addEventListener("click", () => {
      lastEnrichedHandle = null;
      maybeRenderProfileCard();
    });
    return;
  }
  if (!profile.onDigg) { card.classList.add("is-empty"); return; }

  card.classList.remove("is-loading");
  card.innerHTML = renderProfileCard(profile, featured);

  // Wire mini-story buttons to open the panel into the story view.
  card.querySelectorAll(".digg-mini-story").forEach((btn) => {
    btn.addEventListener("click", () => {
      openPanel({ source: "digg-host", type: "navigate", view: "story", slug: btn.dataset.storyId });
    });
  });
}

// ============================================================
//  Inline UserCell badges
// ============================================================
const inflightHandles = new Map();
function lookupProfile(handle) {
  const k = handle.toLowerCase();
  if (inflightHandles.has(k)) return inflightHandles.get(k);
  const p = sendMessage({ type: "digg:profile", username: handle }).then((r) =>
    r && r.ok && r.data && r.data.onDigg ? r.data : null
  );
  inflightHandles.set(k, p);
  setTimeout(() => inflightHandles.delete(k), 60_000);
  return p;
}
function badgeHtml(profile) {
  const cat = profile.category?.label || "On Digg";
  const href = profile.profileUrl || `${DIGG_HOST}/u/x/${encodeURIComponent(profile.username)}`;
  return `<a class="digg-inline-badge" href="${href}" target="_blank" rel="noopener" title="${escapeHtml(cat)} — Gravity ${escapeHtml(profile.gravity || "—")} on Digg">
    ${ICONS.spark}<span>${escapeHtml(cat)}</span>
  </a>`;
}
function extractHandleFromUserCell(cell) {
  const a = cell.querySelector('a[role="link"][href^="/"]:not([href*="/status/"])');
  if (!a) return null;
  const m = /^\/([A-Za-z0-9_]{1,15})(?:\/|$)/.exec(a.getAttribute("href") || "");
  if (!m) return null;
  if (RESERVED_PATHS.has(m[1].toLowerCase())) return null;
  return m[1];
}
async function enrichUserCells(root) {
  const cells = (root || document).querySelectorAll('[data-testid="UserCell"]:not([data-digg-checked])');
  for (const cell of cells) {
    cell.setAttribute("data-digg-checked", "1");
    const handle = extractHandleFromUserCell(cell);
    if (!handle) continue;
    const profile = await lookupProfile(handle);
    if (!profile) continue;
    if (cell.querySelector(".digg-inline-badge")) continue;
    const nameNode = cell.querySelector('[data-testid="User-Name"]') || cell.querySelector('a[role="link"] span');
    if (!nameNode) continue;
    const wrapper = document.createElement("span");
    wrapper.innerHTML = badgeHtml(profile);
    nameNode.appendChild(wrapper.firstElementChild);
  }
}

// ============================================================
//  Right-column "Trending on Digg" widget
// ============================================================
async function injectTrendingWidget() {
  const sidebar = document.querySelector('[data-testid="sidebarColumn"]');
  if (!sidebar) return;
  if (sidebar.querySelector(".digg-trending-widget")) return;

  // Mount as a sibling of the existing right-column section widgets. We pick
  // the first <section> with role="region" and prepend our widget before it.
  const firstSection = sidebar.querySelector('section[role="region"]');
  if (!firstSection || !firstSection.parentElement) return;

  const resp = await sendMessage({ type: "digg:feed" });
  if (!resp || !resp.ok || !resp.data) return;
  const stories = (resp.data.stories || []).slice(0, 5);
  if (!stories.length) return;
  const trending = resp.data.trending || {};

  const widget = document.createElement("section");
  widget.className = "digg-trending-widget";
  widget.setAttribute("aria-label", "Trending on Digg");
  widget.innerHTML = `
    <header>
      <span class="flame">${ICONS.flame}</span>
      <span class="digg-trend-brand">Trending on ${ICONS.wordmark}</span>
      <span class="digg-trend-status">${
        typeof trending.storiesToday === "number" ? `${trending.storiesToday} today` : ""
      }</span>
    </header>
    <ol>
      ${stories.map((s, i) => {
        const slug = s.clusterUrlId || s.shortId || "";
        const meta = [
          `#${s.rank ?? i + 1}`,
          typeof s.postCount === "number" ? `${s.postCount} posts` : null
        ].filter(Boolean).join(" · ");
        return `<li><button type="button" data-story-id="${escapeHtml(slug)}">
          <div class="digg-trend-meta"><span class="digg-trend-rank">${escapeHtml(meta)}</span></div>
          <div class="digg-trend-title">${escapeHtml(s.title || s.headline || "")}</div>
        </button></li>`;
      }).join("")}
    </ol>
    <footer>
      <button type="button" data-action="open-all">See all on Digg →</button>
    </footer>
  `;

  firstSection.parentElement.insertBefore(widget, firstSection);

  widget.querySelectorAll("button[data-story-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openPanel({ source: "digg-host", type: "navigate", view: "story", slug: btn.dataset.storyId });
    });
  });
  widget.querySelector('[data-action="open-all"]').addEventListener("click", () => {
    openPanel({ source: "digg-host", type: "navigate", view: "trending" });
  });
}

// ============================================================
//  Main loop
// ============================================================
let lastPath = "";
function tick() {
  injectSidebarTab();
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    setTimeout(maybeRenderProfileCard, 300);
    setTimeout(maybeRenderProfileCard, 1200);
    setTimeout(injectTrendingWidget, 800);
    setTimeout(injectTrendingWidget, 2000);
  } else {
    maybeRenderProfileCard();
    if (!document.querySelector(".digg-trending-widget")) injectTrendingWidget();
  }
  enrichUserCells();
}

const obs = new MutationObserver(() => {
  if (obs._pending) return;
  obs._pending = true;
  requestAnimationFrame(() => { obs._pending = false; tick(); });
});
obs.observe(document.documentElement, { childList: true, subtree: true });
tick();
