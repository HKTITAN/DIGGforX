// Inline SVG icons — shared between content script and panel.
// Stroke/fill uses currentColor so they pick up the surrounding theme.
window.DIGG_ICONS = {
  // Official Digg wordmark — https://digg.com/digg-logo.svg
  // 300×80 viewBox; render at any height, width scales proportionally.
  wordmark: `<svg viewBox="0 0 300 80" preserveAspectRatio="xMinYMid meet" aria-label="Digg" role="img">
    <g fill="currentColor">
      <path d="M57 0C58.66 0 60 1.34 60 3V13C60 14.66 61.34 16 63 16H77C78.66 16 80 17.34 80 19V61C80 62.66 78.66 64 77 64H63C61.34 64 60 65.34 60 67V77C60 78.66 58.66 80 57 80H3C1.34 80 0 78.66 0 77V35C0 33.34 1.34 32 3 32H17C18.66 32 20 33.34 20 35V60C20 62.21 21.79 64 24 64H57C58.66 64 60 62.66 60 61V19C60 17.34 58.66 16 57 16H3C1.34 16 0 14.66 0 13V3C0 1.34 1.34 0 3 0H57Z"/>
      <path d="M187 0C188.66 0 190 1.34 190 3V13C190 14.66 188.66 16 187 16H153C151.34 16 150 17.34 150 19V61C150 62.66 151.34 64 153 64H187C188.66 64 190 62.66 190 61V52C190 49.79 188.21 48 186 48H173C171.34 48 170 46.66 170 45V35C170 33.34 171.34 32 173 32H207C208.66 32 210 33.34 210 35V61C210 62.66 208.66 64 207 64H193C191.34 64 190 65.34 190 67V77C190 78.66 188.66 80 187 80H153C151.34 80 150 78.66 150 77V67C150 65.34 148.66 64 147 64H133C131.34 64 130 65.34 130 67V77C130 78.66 128.66 80 127 80H113C111.34 80 110 78.66 110 77V67C110 65.34 108.66 64 107 64H93C91.34 64 90 62.66 90 61V35C90 33.34 91.34 32 93 32H107C108.66 32 110 33.34 110 35V61C110 62.66 111.34 64 113 64H127C128.66 64 130 62.66 130 61V19C130 17.34 131.34 16 133 16H147C148.66 16 150 14.66 150 13V3C150 1.34 151.34 0 153 0H187Z"/>
      <path d="M277 0C278.66 0 280 1.34 280 3V13C280 14.66 278.66 16 277 16H243C241.34 16 240 17.34 240 19V61C240 62.66 241.34 64 243 64H277C278.66 64 280 62.66 280 61V52C280 49.79 278.21 48 276 48H263C261.34 48 260 46.66 260 45V35C260 33.34 261.34 32 263 32H297C298.66 32 300 33.34 300 35V61C300 62.66 298.66 64 297 64H283C281.34 64 280 65.34 280 67V77C280 78.66 278.66 80 277 80H243C241.34 80 240 78.66 240 77V67C240 65.34 238.66 64 237 64H223C221.34 64 220 62.66 220 61V19C220 17.34 221.34 16 223 16H237C238.66 16 240 14.66 240 13V3C240 1.34 241.34 0 243 0H277Z"/>
      <path d="M107 0C108.657 0 110 1.34315 110 3V13C110 14.6569 108.657 16 107 16H93C91.3431 16 90 14.6569 90 13V3C90 1.34315 91.3431 0 93 0H107Z"/>
    </g>
  </svg>`,

  // Just the "d" glyph (first path of the wordmark) — perfect 80×80 square,
  // used wherever we need a compact icon (collapsed sidebar tab, etc).
  mark: `<svg viewBox="0 0 80 80" aria-hidden="true">
    <path fill="currentColor" d="M57 0C58.66 0 60 1.34 60 3V13C60 14.66 61.34 16 63 16H77C78.66 16 80 17.34 80 19V61C80 62.66 78.66 64 77 64H63C61.34 64 60 65.34 60 67V77C60 78.66 58.66 80 57 80H3C1.34 80 0 78.66 0 77V35C0 33.34 1.34 32 3 32H17C18.66 32 20 33.34 20 35V60C20 62.21 21.79 64 24 64H57C58.66 64 60 62.66 60 61V19C60 17.34 58.66 16 57 16H3C1.34 16 0 14.66 0 13V3C0 1.34 1.34 0 3 0H57Z"/>
  </svg>`,

  spark: `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path fill="currentColor" d="M12 2l1.6 4.8L18.4 8 14 10.4 12 16 10 10.4 5.6 8l4.8-1.2L12 2Z"/>
  </svg>`,
  arrow: `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M13 5l7 7-7 7"/>
  </svg>`,
  flame: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" d="M12 2s4 4.5 4 8a4 4 0 1 1-8 0c0-1.5.5-2.5 1-3.5 0 2.5 2 2.5 2 2.5S10 6 12 2Z"/>
    <path fill="currentColor" d="M7 14c0 3.3 2.2 6 5 6s5-2.7 5-6c0-1-.3-2-.8-2.8-.4 2.4-1.7 3.3-2.2 3.3 0-1-.5-2-1-2.5-.4 1.5-1.5 2-2 2-.5 0-1.3-.4-1.5-1.2C8.6 12 7 13 7 14Z"/>
  </svg>`,
  close: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/>
  </svg>`
};
