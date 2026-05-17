<p align="center">
  <img src=".github/assets/digg-logo.svg" alt="DIGG" height="80">
</p>

<h1 align="center">DIGG for X</h1>

A Chrome extension that injects [Digg](https://digg.com)'s AI-news layer into [X (twitter.com)](https://x.com) — adds a "Digg" tab to the left sidebar, enriches profile pages with Digg's classification / gravity / vibe & topic distributions, drops a "Trending on Digg" widget into the right column, and includes an in-place story reader so you can read full Digg stories without leaving X.

> ⚠️ **Experimental personal project. Use cautiously.**
> This is a hobby project by [@HKTITAN](https://github.com/HKTITAN). It is not affiliated with, endorsed by, or supported by Digg or X. It works by scraping public pages from `digg.com` — if Digg changes its page layout, parts of the extension will silently stop working until I get around to fixing them. Don't rely on it for anything important. There are no guarantees of correctness, availability, or continued maintenance.

---

## What it does

### 1. Sidebar tab
A "Digg" entry in X's left navigation (next to Home / Explore / Notifications), styled to match. Click to open a slide-out panel. A small green badge shows today's story count.

### 2. Profile page enrichment
On any X profile (`/{handle}`), a Digg card appears above the Posts/Replies tabs with:
- **AI Classification** — Digg's prose summary of who this account is
- **Category** badge (Founder, Researcher, Investor, etc.) — links to that category's Digg rankings
- **Gravity**, **Top followers**, **Followers** — Digg's authority stats
- **Vibe distribution** — top vibes (teaching, informing, supportive, …) as chips with percentages
- **Topic distribution** — top topics this account posts about
- **Featured in** — recent Digg stories that include this user as a source
- **View on Digg** button

### 3. Inline `DIGG · Category` badges
On follower / following / search-result `UserCell` rows, each known-to-Digg account gets a small pill showing their Digg category.

### 4. Right-column "Trending on Digg" widget
Top 5 trending stories slotted in above X's "Live on X" / "You might like" widgets. Click any story → it opens in the slide-out panel, not a new tab.

### 5. In-place story reader
Inside the panel:
- **Trending** — current top stories from `digg.com/ai`
- **Search** — wraps `/api/search/{stories,users,repos}`
- **Story detail** (drill-in):
  - Headline + TL;DR + full summary
  - **Cluster engagement** — 4 sparklines (Views / Comments / Reposts / Bookmarks) from the snapshot time-series
  - **Sentiment** — positive/neutral/negative bar with 4 weighting modes (Raw / Story-weighted / User-weighted / Guarded)
  - **Analysis caveats** — Digg's per-cluster sentiment disclaimers
  - **Posts in this story** — every post with avatar, category badge, content, engagement counts, and an "Open on X →" link

## Install (Chrome / Edge / Brave)

1. Clone or download this repo.
2. Open `chrome://extensions`.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and pick this folder.
5. Visit `https://x.com/` — the Digg tab appears in the left sidebar.

There is no Chrome Web Store listing.

## Architecture

```
digg-x-extension/
├── manifest.json           MV3 manifest, host_permissions: digg.com + x.com
├── background.js           Service worker — all digg.com fetches + HTML/RSC parsing + cache
├── content/
│   ├── inject.js           Sidebar tab, profile card, inline badges, trending widget
│   └── inject.css
├── ui/
│   ├── panel.html          Slide-out panel (rendered inside an iframe)
│   ├── panel.css
│   └── panel.js
├── lib/
│   └── icons.js            Inline SVGs (Digg wordmark, mark, spark, flame, arrow, close)
└── icons/
    └── icon-{16,32,48,128}.png
```

- **Background service worker** owns all cross-origin fetches to `digg.com` (sidesteps CORS via `host_permissions`). It parses three data sources from each fetched page:
  - **JSON-LD** — bulletproof, server-rendered for every page. Primary source for `headline`, `description`, dates, and author lists.
  - **React Server Components stream** (`self.__next_f.push([1, "..."])`) — secondary source for `vibeDistribution`, `topicDistribution`, `snapshots[]`, `sentimentPercentages`, `caveats[]`, etc.
  - **Server-rendered HTML** — only place post content lives. We pair each `x.com/{handle}/status/{id}` link with the adjacent `<p class="whitespace-pre-wrap …">` paragraphs.
- **Two-layer cache** (in-memory Map + `chrome.storage.local`) with per-kind TTLs (profile 30 min, story 10 min, feed 5 min, trending 30 s, search 2 min, negative 5 min).
- **All fetches** use an `AbortController` with a 15 s timeout so the UI never hangs forever.
- **Content script** watches X's SPA navigation via a coalesced `MutationObserver` and targets stable `data-testid` attrs (`AppTabBar_Notifications_Link`, `UserProfileHeader_Items`, `UserCell`, `sidebarColumn`, `ScrollSnap-List`). Missing testids gracefully no-op so X markup churn doesn't break the extension entirely.
- **Panel UI** is rendered in an iframe (own origin) so its styles can't leak into X and X's CSS can't bleed in.

## Endpoints used

All against `https://digg.com`:

| Endpoint | Use |
|---|---|
| `GET /u/x/{username}` (HTML) | Profile enrichment |
| `GET /ai` (HTML) | Trending feed |
| `GET /ai/{shortId}` (HTML) | Story detail (sparklines, sentiment, posts) |
| `GET /api/search/stories?q=&limit=` | Search + "Featured in" lookups |
| `GET /api/search/users?q=&limit=` | People search |
| `GET /api/search/repos?q=&limit=` | Repo search |
| `GET /api/trending/status` | Feed-liveness badge |

No write endpoints are used. No authentication. The extension does not collect, store, or transmit any user data — every fetch is just an unauthenticated GET to a public Digg page.

## Limitations & known issues

- Targets X's current markup (early 2026). Future X redesigns will break individual surfaces until selectors are updated.
- The "Sentiment comments" modal that digg.com renders with per-comment reasoning text is loaded by Digg from a private endpoint that isn't exposed in the public bundle. We can show the post list with content but not the reasoning lines.
- Profile data freshness lags Digg's live state by up to 30 minutes (the profile cache TTL).
- If you reload the extension during development, open X tabs need a refresh — the panel will show a banner prompting you.

## Disclaimer

This extension reads public Digg pages. It is not affiliated with Digg or X / Twitter. All Digg content shown belongs to its respective authors and Digg. The Digg logo is used to identify Digg-sourced content within X. If you're from Digg or X and would like changes made, open an issue.

This is a personal project shared as-is. No warranty. No support guarantees. Don't use it for anything that matters.

Built by [@HKTITAN](https://github.com/HKTITAN).
