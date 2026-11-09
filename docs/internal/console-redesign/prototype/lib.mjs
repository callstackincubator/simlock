
export const WORKERS = [
  { n: "mac-studio-01", os: "macOS 26.6.1", tone: "ok", word: "connected", cpu: 62, mem: 71, disk: 48, ios: "LLLLRR", and: "LLFF", leases: 6, seen: "2 s ago", ver: "0.6.0" },
  { n: "mac-studio-02", os: "macOS 26.6.1", tone: "ok", word: "connected", cpu: 44, mem: 58, disk: 52, ios: "LLLRBF", and: "LFFF", leases: 4, seen: "1 s ago", ver: "0.6.0" },
  { n: "mac-mini-ci-01", os: "macOS 26.5", tone: "ok", word: "connected", cpu: 81, mem: 77, disk: 63, ios: "LL", and: "LLLR", leases: 5, seen: "3 s ago", ver: "0.6.0" },
  { n: "mac-mini-ci-02", os: "macOS 26.5", tone: "warn", word: "disk 91%", cpu: 38, mem: 64, disk: 91, ios: "LLRF", and: "FF", leases: 2, seen: "2 s ago", ver: "0.6.0" },
  { n: "mac-mini-ci-03", os: "macOS 26.5", tone: "ok", word: "connected", cpu: 12, mem: 40, disk: 35, ios: "RRFF", and: "RF", leases: 0, seen: "4 s ago", ver: "0.6.0" },
  { n: "mbp-lab-03", os: "macOS 26.6.1", tone: "warn", word: "drained", cpu: 5, mem: 33, disk: 41, ios: "LFFF", and: "FF", leases: 1, seen: "2 s ago", ver: "0.6.0" },
  { n: "mbp-lab-04", os: "macOS 26.4", tone: "err", word: "disconnected", cpu: 0, mem: 0, disk: 0, ios: "FFFF", and: "FF", leases: 0, seen: "14 min ago", ver: "0.5.2" },
  { n: "phone-rack-01", os: "macOS 26.6.1", tone: "ok", word: "connected", cpu: 9, mem: 28, disk: 22, ios: "LRRA", and: "RR", leases: 1, seen: "1 s ago", ver: "0.6.0" },
];

export const LEASES = [
  ["claude-code/checkout-flow", "iPhone 16 Pro", "iOS 18.4", "ios", "mac-studio-01", "12 min ago", "14:56", 95],
  ["codex/pr-1423-login", "iPhone 16", "iOS 18.4", "ios", "mac-studio-01", "9 min ago", "11:20", 75],
  ["claude-code/search-ranking", "Pixel 9", "Android 15", "android", "mac-mini-ci-01", "31 min ago", "08:02", 53],
  ["cursor/nav-redesign", "iPhone 15", "iOS 17.5", "ios", "mac-studio-02", "4 min ago", "13:41", 91],
  ["ci/nightly-smoke", "Pixel 8", "Android 14", "android", "mac-mini-ci-01", "52 min ago", "04:12", 28],
  ["claude-code/billing-webhooks", "iPhone 16", "iOS 18.4", "ios", "mac-mini-ci-02", "18 min ago", "09:47", 65],
  ["codex/pr-1430-deeplinks", "iPad Air 11-inch", "iPadOS 18.4", "ios", "mac-studio-02", "2 min ago", "14:10", 94],
  ["ci/release-candidate", "iPhone 14 · physical", "iOS 18.3", "ios", "phone-rack-01", "1 h 4 min ago", "02:36", 17],
  ["claude-code/onboarding-copy", "Pixel 9 Pro", "Android 15", "android", "mac-mini-ci-01", "7 min ago", "12:03", 80],
  ["codex/pr-1441-cache", "iPhone 16", "iOS 18.4", "ios", "mac-studio-01", "22 min ago", "06:55", 46],
  ["cursor/settings-a11y", "Pixel Tablet", "Android 15", "android", "mac-studio-02", "15 min ago", "10:30", 70],
  ["claude-code/push-optin", "iPhone 16 Pro Max", "iOS 18.4", "ios", "mbp-lab-03", "40 min ago", "05:18", 35],
  ["codex/pr-1444-i18n", "Pixel 9", "Android 15", "android", "mac-mini-ci-01", "6 min ago", "12:44", 85],
  ["ci/perf-baseline", "iPhone 16", "iOS 18.4", "ios", "mac-mini-ci-02", "27 min ago", "07:31", 50],
];

export const EVENTS = [
  ["18:17:42", "lease.granted", "ok", "claude-code/checkout-flow", "mac-studio-01", "iPhone 16 Pro · iOS 18.4"],
  ["18:17:40", "queue.changed", "idle", "codex/pr-1447-forms", "gateway", "place 2 → 1"],
  ["18:17:31", "lease.renewed", "idle", "codex/pr-1423-login", "mac-studio-01", "ttl 15 min"],
  ["18:17:12", "device.ready", "ok", "Pixel 9 · Android 15", "mac-mini-ci-01", "booted in 6.4 s"],
  ["18:16:58", "lease.requested", "idle", "codex/pr-1447-forms", "gateway", "ios · iPhone 16 · 18.4"],
  ["18:16:44", "lease.released", "idle", "cursor/tab-bar-polish", "mac-studio-02", "held 21 min"],
  ["18:16:20", "worker.drain-started", "warn", "mbp-lab-03", "gateway", "by tok_262f…d582"],
  ["18:15:51", "device.quarantined", "err", "iPhone 15 · iOS 17.5", "mac-mini-ci-02", "boot timed out after 120 s"],
  ["18:15:33", "lease.granted", "ok", "codex/pr-1430-deeplinks", "mac-studio-02", "iPad Air 11-inch · iPadOS 18.4"],
  ["18:15:02", "lease.expired", "warn", "ci/flaky-retry-7", "mac-mini-ci-01", "not renewed for 15 min"],
  ["18:14:47", "baseline.built", "ok", "android-35-pixel9", "mac-mini-ci-01", "5.1 GB in 3 min 12 s"],
  ["18:14:20", "lease.renewed", "idle", "claude-code/search-ranking", "mac-mini-ci-01", "ttl 15 min"],
  ["18:13:58", "worker.disconnected", "err", "mbp-lab-04", "gateway", "no heartbeat for 30 s"],
  ["18:13:11", "lease.granted", "ok", "cursor/nav-redesign", "mac-studio-02", "iPhone 15 · iOS 17.5"],
  ["18:12:40", "device.booting", "idle", "iPhone 16 · iOS 18.4", "mac-studio-02", "warm pool refill"],
  ["18:12:05", "lease.released", "idle", "ci/unit-shard-3", "mac-mini-ci-03", "held 8 min"],
  ["18:11:37", "lease.granted", "ok", "claude-code/onboarding-copy", "mac-mini-ci-01", "Pixel 9 Pro · Android 15"],
  ["18:11:02", "queue.changed", "idle", "ci/release-candidate", "gateway", "place 1 → granted"],
  ["18:10:30", "lease.renewed", "idle", "ci/nightly-smoke", "mac-mini-ci-01", "ttl 15 min"],
  ["18:09:58", "device.ready", "ok", "iPhone 16 · iOS 18.4", "mac-studio-01", "booted in 4.1 s"],
];

export const BASELINES = [
  ["ios-18.4-iphone16", "ios", "iPhone 16", "18.4", "6.2 GB", 62, "mac-studio-01", "2 h ago", "ok", "ready", ""],
  ["ios-18.4-iphone16pro", "ios", "iPhone 16 Pro", "18.4", "6.4 GB", 64, "mac-studio-01", "2 h ago", "ok", "ready", ""],
  ["ios-18.4-ipadair11", "ios", "iPad Air 11-inch", "18.4", "7.0 GB", 70, "mac-studio-02", "5 h ago", "ok", "ready", ""],
  ["ios-17.5-iphone15", "ios", "iPhone 15", "17.5", "5.8 GB", 58, "mac-mini-ci-02", "6 days ago", "warn", "stale", "Xcode 26.4 replaced the runtime this baseline was built on"],
  ["android-35-pixel9", "android", "Pixel 9", "15", "5.1 GB", 51, "mac-mini-ci-01", "4 min ago", "ok", "ready", ""],
  ["android-35-pixel9pro", "android", "Pixel 9 Pro", "15", "5.3 GB", 53, "mac-mini-ci-01", "1 h ago", "ok", "ready", ""],
  ["android-35-pixel8", "android", "Pixel 8", "15", "3.2 GB", 32, "mac-mini-ci-01", "now", "idle", "building 62%", ""],
  ["android-34-pixel8", "android", "Pixel 8", "14", "4.6 GB", 46, "mac-studio-02", "3 days ago", "ok", "ready", ""],
  ["android-35-pixeltablet", "android", "Pixel Tablet", "15", "5.9 GB", 59, "mac-studio-02", "1 day ago", "ok", "ready", ""],
];

export const DEVICES = [
  ["iPhone 16 Pro", "iOS 18.4", "leased", "L", "claude-code/checkout-flow", "14:56", 95],
  ["iPhone 16", "iOS 18.4", "leased", "L", "codex/pr-1423-login", "11:20", 75],
  ["iPhone 16", "iOS 18.4", "leased", "L", "codex/pr-1441-cache", "06:55", 46],
  ["iPhone 15", "iOS 17.5", "leased", "L", "ci/ui-shard-2", "09:12", 61],
  ["iPhone 16", "iOS 18.4", "ready", "R", "", "", 0],
  ["iPad Air 11-inch", "iPadOS 18.4", "ready", "R", "", "", 0],
  ["Pixel 9", "Android 15", "leased", "L", "ci/android-shard-1", "12:20", 82],
  ["Pixel 9 Pro", "Android 15", "leased", "L", "cursor/widget-sizes", "03:48", 25],
];

const PATHS = {
  overview: '<rect x="2.5" y="2.5" width="4.5" height="4.5"/><rect x="9" y="2.5" width="4.5" height="4.5"/><rect x="2.5" y="9" width="4.5" height="4.5"/><rect x="9" y="9" width="4.5" height="4.5"/>',
  inbox: '<path d="M2 9l2-6h8l2 6v4H2z"/><path d="M2 9h3.5l1 2h3l1-2H14"/>',
  fleet: '<rect x="2" y="3" width="12" height="4"/><rect x="2" y="9" width="12" height="4"/><path d="M4.5 5h.01M4.5 11h.01"/>',
  leases: '<circle cx="5" cy="11" r="2.5"/><path d="M7 9l6-6M11 5l2 2"/>',
  queue: '<path d="M2 4h12M2 8h9M2 12h6"/>',
  baselines: '<path d="M8 2l6 3-6 3-6-3z"/><path d="M2 8l6 3 6-3M2 11l6 3 6-3"/>',
  activity: '<path d="M1.5 8h3l2-5 3 10 2-5h3"/>',
  usage: '<path d="M2 14h12M4.5 14V8M8 14V3M11.5 14v-4"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
  x: '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>',
  chev: '<path d="M6 3l5 5-5 5"/>',
  down: '<path d="M3 6l5 5 5-5"/>',
  out: '<path d="M6 2H3v12h3M7 8h7M11 5l3 3-3 3"/>',
  check: '<path d="M3 8.5l3.5 3.5L13 4.5"/>',
  filter: '<path d="M2 3h12l-4.5 5.5V13l-3-1.5V8.5z"/>',
  phone: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.5"/><path d="M7 12.5h2"/>',
};
export const icon = (name, size = 16) =>
  name === "dots"
    ? `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>`
    : `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`;

export const NAV = [
  ["overview", "Overview"],
  ["inbox", "Inbox", 2],
  ["fleet", "Fleet", 0, "Operate"],
  ["leases", "Leases"],
  ["queue", "Queue"],
  ["baselines", "Baselines"],
  ["activity", "Activity", 0, "Observe"],
  ["usage", "Usage"],
];

export const sq = (tone) => `<i class="sq ${tone}"></i>`;
export const st = (tone, word) => `<span class="st">${sq(tone)}${word}</span>`;
export const slots = (codes) =>
  `<span class="slots">${[...codes].map((c) => `<i class="sl ${c}"></i>`).join("")}</span>`;
export const loadTone = (p) => (p >= 95 ? "err" : p >= 85 ? "warn" : "");
export const meter = (pct, tone = "") =>
  `<span class="meter ${tone}"><i style="width:${pct}%"></i></span>`;
export const ttlTone = (pct) => (pct < 34 ? "warn" : "");

export function tbl(cols, rows, { sel = -1, cls = "", rowCls = () => "" } = {}) {
  const head = cols.map((c) => `<th class="${c.c ?? ""}">${c.h}</th>`).join("");
  const body = rows
    .map(
      (r, i) =>
        `<tr class="${i === sel ? "sel" : ""} ${rowCls(i)}">${r
          .map((cell, j) => `<td class="${cols[j].c ?? ""}">${cell}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  const group = cols.map((c) => `<col style="width:${c.w ?? "auto"}">`).join("");
  return `<table class="tbl ${cls}"><colgroup>${group}</colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function rng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function series(seed, n, base, amp, drift = 0) {
  const r = rng(seed);
  let v = base;
  return Array.from({ length: n }, (_, i) => {
    v += (r() - 0.5) * amp + drift;
    v = Math.max(0, v);
    return Math.round((v + Math.sin(i / 4) * amp * 0.6) * 10) / 10;
  }).map((x) => Math.max(0, x));
}

export function spark(data, w = 72, h = 24) {
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`);
  return `<svg class="spark" width="${w}" height="${h}"><polygon class="ch-fill" points="0,${h} ${pts.join(" ")} ${w},${h}"/><polyline class="ch-line" fill="none" points="${pts.join(" ")}"/></svg>`;
}

const HOURS = ["17:18", "17:28", "17:38", "17:48", "17:58", "18:08", "18:18"];
export function area(data, w, h, { max, ticks = 4, smooth = false } = {}) {
  const top = max ?? Math.ceil(Math.max(...data) / ticks) * ticks;
  const L = 28, B = 20, T = 6;
  const iw = w - L, ih = h - B - T;
  const xy = data.map((v, i) => [L + (i / (data.length - 1)) * iw, T + ih - (v / top) * ih]);
  let d;
  if (smooth) {
    d = `M${xy[0][0]},${xy[0][1]}`;
    for (let i = 1; i < xy.length; i++) {
      const [x0, y0] = xy[i - 1], [x1, y1] = xy[i];
      const mx = (x0 + x1) / 2;
      d += ` C${mx.toFixed(1)},${y0.toFixed(1)} ${mx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
    }
  } else d = "M" + xy.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L");
  let grid = "";
  for (let i = 0; i <= ticks; i++) {
    const y = T + ih - (i / ticks) * ih;
    grid += `<line class="ch-grid" x1="${L}" x2="${w}" y1="${y}" y2="${y}"/><text class="ch-ax" x="${L - 8}" y="${y + 3.5}" text-anchor="end">${Math.round((top / ticks) * i)}</text>`;
  }
  const labels = HOURS.map((t, i) => {
    const x = L + (i / (HOURS.length - 1)) * iw;
    return `<text class="ch-ax" x="${x}" y="${h - 4}" text-anchor="${i === 0 ? "start" : i === HOURS.length - 1 ? "end" : "middle"}">${t}</text>`;
  }).join("");
  const last = xy[xy.length - 1];
  return `<svg class="chart" width="${w}" height="${h}">${grid}<path class="ch-fill" d="${d} L${w},${T + ih} L${L},${T + ih} Z"/><path class="ch-line" fill="none" d="${d}"/><circle class="ch-dot" cx="${last[0]}" cy="${last[1]}" r="3"/>${labels}</svg>`;
}

export function bars(data, w, h, { gap = 2, hot = [] } = {}) {
  const max = Math.max(...data, 1);
  const bw = (w - gap * (data.length - 1)) / data.length;
  return `<svg class="barsvg" width="${w}" height="${h}">${data
    .map((v, i) => {
      const bh = Math.max(1, (v / max) * (h - 2));
      return `<rect class="ch-bar ${hot.includes(i) ? "hot" : ""}" x="${(i * (bw + gap)).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}"/>`;
    })
    .join("")}</svg>`;
}

export function ring(pct, size, tone = "", stroke = 5) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return `<svg class="ring ${tone}" width="${size}" height="${size}"><circle class="rt" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/><circle class="rv" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${(c * pct) / 100} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
}

export const BASE_CSS = `
.screen{width:1440px;height:900px;overflow:hidden;position:relative;font-family:'Geist',system-ui,sans-serif;-webkit-font-smoothing:antialiased;font-feature-settings:"tnum"}
.screen *{box-sizing:border-box}
.screen svg{display:block;flex:none}
.mono{font-family:'Geist Mono',ui-monospace,monospace}
.mu{color:var(--mu)}
.lab{font-family:'Geist Mono',monospace;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--mu);font-weight:500}
.sq{display:inline-block;width:8px;height:8px;background:var(--idle);margin-right:8px;flex:none}
.sq.ok{background:var(--ok)}.sq.warn{background:var(--warn)}.sq.err{background:var(--err)}
.st{display:inline-flex;align-items:center;white-space:nowrap}
.slots{display:inline-flex;gap:3px;vertical-align:middle}
.sl{width:12px;height:12px;display:block}
.sl.L{background:var(--leased)}.sl.R{background:var(--ok)}.sl.B{background:var(--idle)}.sl.Q{background:var(--err)}.sl.A{background:var(--warn)}.sl.F{border:1px dashed var(--bd2)}
.meter{display:block;height:4px;background:var(--track);position:relative;flex:1;min-width:0}
.meter i{position:absolute;inset:0 auto 0 0;background:var(--leased)}
.meter.warn i{background:var(--warn)}.meter.err i{background:var(--err)}
.mc{display:flex;align-items:center;gap:8px}
.mc b{font:500 12px 'Geist Mono',monospace;width:32px;text-align:right;flex:none}
.tbl{width:100%;border-collapse:collapse;table-layout:fixed}
.tbl th,.tbl td{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;vertical-align:middle}
.tbl .num{text-align:right;font-family:'Geist Mono',monospace}
.tbl .act{text-align:right;overflow:visible}
.ch-ax{font:10px 'Geist Mono',monospace;fill:var(--mu)}
.ch-grid{stroke:var(--bd);stroke-width:1}
.ch-line{stroke:var(--ac);stroke-width:1.5}
.ch-fill{fill:var(--ac);opacity:.09;stroke:none}
.ch-dot{fill:var(--ac)}
.ch-bar{fill:var(--leased);opacity:.55}.ch-bar.hot{fill:var(--ac);opacity:1}
.rt{stroke:var(--track)}.rv{stroke:var(--leased)}.ring.warn .rv{stroke:var(--warn)}.ring.err .rv{stroke:var(--err)}.ring.ok .rv{stroke:var(--ok)}
.row{display:flex;align-items:center}
.grow{flex:1;min-width:0}
.ell{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;
