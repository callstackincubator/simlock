import { WORKERS, LEASES, EVENTS, BASELINES, DEVICES, NAV, icon, sq, slots, loadTone, meter, ttlTone, tbl, series, area, bars, ring } from "./lib.mjs";

export const css = `
.vd{--bg:#0c0c0e;--sf:#141416;--sf2:#1b1b1f;--bd:#232327;--bd2:#3a3a41;--tx:#ececea;--mu:#8e8e97;--ac:#ff7a1a;--act:#ffa061;--ok:#4ade80;--warn:#facc15;--err:#f87171;--idle:#6f6f79;--leased:#d6d6d0;--track:#26262b;--r:10px;
  background:var(--bg);color:var(--tx);font-size:13px;line-height:1.45;display:grid;grid-template-columns:212px 1fr}
.vd .sb{margin:12px 0 12px 12px;background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);display:flex;flex-direction:column;padding:12px 10px 10px;min-height:0}
.vd .wm{display:flex;align-items:center;gap:9px;font-weight:700;font-size:14px;letter-spacing:-.01em;margin:0 6px 14px}
.vd .wm i{width:24px;height:24px;border-radius:7px;background:var(--ac);display:flex;align-items:center;justify-content:center;color:#111;font-style:normal;font-size:13px}
.vd .find{display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;background:var(--bg);border:1px solid var(--bd);border-radius:8px;color:var(--mu);margin-bottom:8px}
.vd kbd{font:500 10.5px/1 'Geist Mono';border:1px solid var(--bd2);border-radius:4px;height:18px;padding:0 5px;display:inline-flex;align-items:center;margin-left:auto;color:var(--mu)}
.vd .nl{display:flex;align-items:center;gap:10px;height:32px;padding:0 10px;color:var(--mu);border-radius:8px;font-weight:500}
.vd .nl.cur{background:#2a2016;color:var(--act)}
.vd .nl .cnt{margin-left:auto;font:600 10.5px/1 'Geist Mono';background:var(--err);color:#0b0b0c;border-radius:99px;height:18px;min-width:18px;padding:0 6px;display:inline-flex;align-items:center;justify-content:center}
.vd .ng{padding:14px 10px 4px;font:500 10.5px 'Geist Mono';letter-spacing:.08em;text-transform:uppercase;color:var(--idle)}
.vd .me{margin-top:auto;display:flex;align-items:center;gap:9px;padding:8px;background:var(--bg);border:1px solid var(--bd);border-radius:8px}
.vd .av{width:26px;height:26px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font:600 10px 'Geist Mono';flex:none;background:#24242a;color:#b9b9c2}
.vd .av.cc{background:#3a2a18;color:#f5c08a}.vd .av.cx{background:#1d2d3b;color:#9cc4e6}.vd .av.cu{background:#2a2440;color:#bdb1ea}.vd .av.ci{background:#1c3022;color:#9ad6ae}.vd .av.pi{background:#1c3022;color:#9ad6ae}
.vd main{min-width:0;min-height:0;padding:12px 12px 12px 12px;display:flex;flex-direction:column;gap:12px}
.vd .ph{display:flex;align-items:center;gap:12px;min-height:40px;padding:2px 4px 0}
.vd .ph>div:first-child{min-width:0}
.vd .pr{flex:none}
.vd h1{margin:0;font-size:21px;font-weight:600;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vd h1 .crumb{color:var(--mu);font-weight:500}
.vd .sub{color:var(--mu);font-size:12.5px;margin-top:1px}
.vd .pr{margin-left:auto;display:flex;align-items:center;gap:8px}
.vd .card{background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.vd .card.err{border-color:#4a2626}.vd .card.warn{border-color:#4a3f1a}
.vd .chd{height:38px;display:flex;align-items:center;gap:8px;padding:0 14px;flex:none;border-bottom:1px solid var(--bd)}
.vd .chd.bare{border-bottom:0}
.vd .chd .r{margin-left:auto;font:11.5px 'Geist Mono';color:var(--mu)}
.vd .gh{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;margin:2px 2px 0}
.vd .gh .n{font:500 11px/1 'Geist Mono';color:var(--mu);background:var(--sf2);border:1px solid var(--bd);border-radius:99px;height:18px;min-width:18px;padding:0 6px;display:inline-flex;align-items:center;justify-content:center}
.vd .btn{height:30px;padding:0 12px;border:1px solid var(--bd2);border-radius:8px;font-weight:500;font-size:12.5px;line-height:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;color:var(--tx);background:var(--sf)}
.vd .btn.pri{background:var(--ac);border-color:var(--ac);color:#0e0e0f}
.vd .btn.danger{color:var(--err);border-color:#6b2c2c}
.vd .btn.sm{height:26px;padding:0 9px;font-size:12px}
.vd .seg{display:inline-flex;background:var(--sf2);border:1px solid var(--bd);border-radius:8px;padding:2px;gap:2px}
.vd .seg span{height:26px;padding:0 10px;display:inline-flex;align-items:center;justify-content:center;line-height:1;font-weight:500;font-size:12px;color:var(--mu);border-radius:6px}
.vd .seg .on{background:#2a2a30;color:var(--tx)}
.vd .seg em{font-style:normal;opacity:.55;margin-left:6px;font:11px 'Geist Mono'}
.vd .pill{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:20px;padding:0 8px;border-radius:99px;font-size:11.5px;line-height:1;font-weight:500;background:#24242a;color:#b9b9c2;white-space:nowrap}
.vd .pill::before{content:"";width:6px;height:6px;border-radius:99px;background:currentColor}
.vd .pill.ok{background:rgba(74,222,128,.13);color:#86efac}.vd .pill.warn{background:rgba(250,204,21,.13);color:#fde047}.vd .pill.err{background:rgba(248,113,113,.15);color:#fca5a5}
.vd .pill.plain::before{display:none}
.vd .pill.plain{padding:0 8px}
.vd .big{font:500 28px 'Geist Mono';letter-spacing:-.03em;line-height:1}
.vd .big small{font-size:12px;color:var(--mu);letter-spacing:0;margin-left:6px;font-weight:400}
.vd .kpi{padding:12px 14px;justify-content:space-between;gap:8px}
.vd .kpi .row{align-items:flex-end;gap:10px}
.vd .kpi .big{white-space:nowrap;flex:1;min-width:0}
.vd .kpi svg{margin-left:auto}
.vd .hero{flex-direction:row;align-items:center;gap:14px;padding:11px 14px;background:linear-gradient(90deg,var(--sf) 0%,#1d1612 100%);border-color:#3a2a20}
.vd .hero .ib{width:32px;height:32px;border-radius:9px;background:rgba(248,113,113,.15);color:var(--err);display:flex;align-items:center;justify-content:center;font:700 14px 'Geist Mono';flex:none}
.vd .wall{display:grid;gap:1px;background:var(--bd)}
.vd .wt{background:var(--sf);padding:11px 14px;display:flex;flex-direction:column;gap:8px;min-width:0}
.vd .wt .nm{font:500 12.5px 'Geist Mono'}
.vd .wt .mc b{width:auto;font-size:11px;color:var(--mu);font-weight:400}
.vd .wt .mc span.l{font:10px 'Geist Mono';color:var(--mu);width:26px;letter-spacing:.06em}
.vd .wt.err{background:#19100f}.vd .wt.warn{background:#17140c}
.vd .fc{padding:14px;gap:12px}
.vd .clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.vd .frac{font:500 12px 'Geist Mono';color:var(--mu);white-space:nowrap}
.vd .sbar2{display:flex;align-items:center;gap:8px;min-width:0}.vd .sbar2 .meter{flex:1}
.vd .wrap{word-break:break-all;white-space:normal}
.vd .fc .nm{font:500 13.5px 'Geist Mono'}
.vd .fc .sl{width:16px;height:16px}.vd .fc .slots{gap:4px}
.vd .fc .mc{gap:8px}
.vd .ringbox{position:relative;display:inline-flex;flex:none}
.vd .ringbox span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:600 12.5px 'Geist Mono'}
.vd .ringbox.sm span{font-size:9.5px}
.vd .tbl th{height:34px;padding:0 10px;font:500 10.5px 'Geist Mono';letter-spacing:.08em;text-transform:uppercase;color:var(--mu);border-bottom:1px solid var(--bd);background:var(--sf2)}
.vd .tbl td{height:40px;padding:0 10px;border-bottom:1px solid #1c1c20;font-size:12.5px}
.vd .tbl th:first-child,.vd .tbl td:first-child{padding-left:14px}
.vd .tbl tr.sel td{background:#221913}
.vd .tbl tr.sel td:first-child{box-shadow:inset 2px 0 0 var(--ac)}
.vd .tbl tr.grp td{background:var(--sf2);font:500 10.5px 'Geist Mono';letter-spacing:.08em;text-transform:uppercase;color:var(--mu);height:28px}
.vd .tbl .more{color:var(--mu)}
.vd .who{display:flex;align-items:center;gap:9px;min-width:0}
.vd .who b{font-weight:500;display:block}
.vd .who small{color:var(--mu);font-size:11.5px;display:block}
.vd .item{display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid var(--bd);font-size:12.5px}
.vd .ttl{display:flex;align-items:center;gap:8px}
.vd .ttl b{font:500 12px 'Geist Mono';width:40px}
.vd .facts{display:grid;grid-template-columns:92px 1fr;row-gap:8px;font-size:12.5px}
.vd .facts>:nth-child(odd){color:var(--mu)}
.vd .tabs{display:flex;gap:18px;border-bottom:1px solid var(--bd);padding:0 14px;flex:none}
.vd .tabs span{font:500 10.5px 'Geist Mono';letter-spacing:.08em;text-transform:uppercase;color:var(--mu);padding:10px 0;border-bottom:2px solid transparent;margin-bottom:-1px}
.vd .tabs .on{color:var(--tx);border-bottom-color:var(--ac)}
.vd .dv{padding:11px 12px;gap:7px}
.vd .dv .scr{height:66px;border-radius:6px;background:repeating-linear-gradient(135deg,#17171a 0 6px,#121214 6px 12px);border:1px solid var(--bd);display:flex;align-items:center;justify-content:center;color:var(--idle);font:10px 'Geist Mono';letter-spacing:.08em}
.vd .log{font:12px/1 'Geist Mono';display:grid;grid-template-columns:70px 14px 180px 240px 150px 1fr;align-items:center;height:30px;padding:0 14px;border-bottom:1px solid #181819;white-space:nowrap}
.vd .log>*{overflow:hidden;text-overflow:ellipsis}
.vd .log.err{background:#19100f}.vd .log.warn{background:#17140c}
.vd .fe{display:grid;grid-template-columns:26px 1fr auto;gap:12px;align-items:center;height:38px;padding:0 14px;border-bottom:1px solid #181819;font-size:12.5px}
.vd .fe .ico{width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:#24242a;color:#b9b9c2}
.vd .fe .ico.ok{background:rgba(74,222,128,.13);color:#86efac}.vd .fe .ico.warn{background:rgba(250,204,21,.13);color:#fde047}.vd .fe .ico.err{background:rgba(248,113,113,.15);color:#fca5a5}
.vd .fac{min-width:0}.vd .fac>span:not(.bx):not(.n){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vd .fac{display:flex;align-items:center;gap:8px;height:30px;padding:0 14px;font-size:12.5px}
.vd .fac .n{margin-left:auto;font:11px 'Geist Mono';color:var(--mu)}
.vd .fac .bx{width:14px;height:14px;border-radius:4px;border:1px solid var(--bd2);display:inline-flex;align-items:center;justify-content:center}
.vd .fac .bx.on{background:var(--ac);border-color:var(--ac);color:#0e0e0f}
.vd .g{display:grid;gap:12px}
.vd .phone{width:300px;height:650px;border-radius:34px;background:#000;border:6px solid #2a2a30;box-shadow:0 20px 60px -20px rgba(0,0,0,.8);position:relative;overflow:hidden;margin:0 auto}
.vd .phone .scrn{position:absolute;inset:0;background:#f6f6f8;color:#111;font-family:'Geist';display:flex;flex-direction:column}
.vd .phone .sbar{height:44px;display:flex;align-items:center;justify-content:space-between;padding:12px 26px 0;font-weight:600;font-size:13px}
.vd .phone .notch{position:absolute;top:10px;left:50%;transform:translateX(-50%);width:96px;height:28px;border-radius:99px;background:#000}
.vd .phone .appbar{padding:18px 18px 10px;font-size:22px;font-weight:700;letter-spacing:-.02em}
.vd .phone .fld{margin:8px 16px 0;height:44px;border-radius:10px;background:#fff;border:1px solid #e3e3e8;display:flex;align-items:center;padding:0 12px;font-size:13px;color:#555}
.vd .phone .fld b{color:#111;font-weight:500;margin-left:auto}
.vd .phone .cta{margin:18px 16px 0;height:48px;border-radius:12px;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px}
.vd .phone .cur{position:absolute;width:22px;height:22px;border-radius:99px;border:2px solid var(--ac);background:rgba(255,122,26,.25);left:168px;top:418px}
.vd .ov{position:absolute;z-index:2;display:inline-flex;align-items:center;gap:6px;font:500 11px/1 'Geist Mono';padding:5px 8px;border-radius:99px;background:rgba(12,12,14,.78);color:#ececea;backdrop-filter:blur(6px)}
.vd .ov i{width:6px;height:6px;border-radius:99px;background:var(--ok);display:inline-block}
.vd .stage{display:grid;grid-template-columns:34px 1fr;gap:10px;align-items:start;padding:10px 14px;border-bottom:1px solid var(--bd);font-size:12.5px}
.vd .stage:last-child{border-bottom:0}
.vd .stage .no{width:34px;height:34px;border-radius:8px;background:var(--sf2);display:flex;align-items:center;justify-content:center;font:600 12px 'Geist Mono';color:var(--mu)}
.vd .stage b{display:block;font-weight:600;margin-bottom:2px}

`;

const kind = (h) => (/^claude(-code)?[:/]/.test(h) ? ["cc", "CC"] : /^codex[:/]/.test(h) ? ["cx", "CX"] : /^cursor[:/]/.test(h) ? ["cu", "CU"] : /^pi[:/]/.test(h) ? ["pi", "PI"] : ["", "·"]);
const av = (h) => `<span class="av ${kind(h)[0]}">${kind(h)[1]}</span>`;
const hid = (h, max = 34) => (h.length <= max ? h : `${h.slice(0, max - 9)}…${h.slice(-6)}`);
const who = (h, cls = "", style = "") => `<span class="mono ${cls}" style="white-space:nowrap;${style}" title="${h}">${hid(h)}</span>`;
const slotsCap = (codes, _gap = 3) => { const n = codes.length, l = [...codes].filter((c) => c === "L").length; return n <= 10 ? slots(codes) : `<span class="sbar2 grow">${meter(Math.round((l / n) * 100))}<span class="frac">${l} / ${n}</span></span>`; };
const W = WORKERS.map((w) => w.n === "mac-studio-02" ? { ...w, ios: "LLLLLLLRRRBF", and: "LLLFFFFF", leases: 10 } : w.n === "mbp-lab-04" ? { ...w, n: "Szymons-MacBook-Pro.local" } : w);
const L = LEASES.map((l, i) => i === 1 ? ["codex:8c1e2f4a-0b7d-4e21-9c3a-5f6d7e8a9b0c", ...l.slice(1)] : i === 4 ? ["ci-nightly", ...l.slice(1)] : i === 9 ? ["mcp:48213", ...l.slice(1)] : i === 7 ? ["release-bot", ...l.slice(1)] : i === 13 ? ["claude-code:3f2a9c1e-7b44-4d0e-a2f1-0c9d8e7f91c4", ...l.slice(1)] : l);
const pill = (tone, word) => `<span class="pill ${tone}">${word}</span>`;
const seg = (items, on = 0) => `<div class="seg">${items.map((x, i) => `<span class="${i === on ? "on" : ""}">${x}</span>`).join("")}</div>`;
const ttl = (t, pct) => `<div class="ttl"><b>${t}</b>${meter(pct, ttlTone(pct))}</div>`;
const range = seg(["1 h", "6 h", "24 h", "7 d"]);
const more = `<span class="more">${icon("dots")}</span>`;
const rbox = (pct, size, tone = "", stroke = 5) => `<span class="ringbox">${ring(pct, size, tone, stroke)}<span>${pct}%</span></span>`;
const m3 = (w) => ["cpu", "mem", "disk"].map((k) => `<div class="mc"><span class="l">${k.toUpperCase()}</span>${meter(w[k], loadTone(w[k]))}<b>${w[k] ? w[k] + "%" : "—"}</b></div>`).join("");

function shell(cur, title, sub, right, body) {
  const nav = NAV.map(([key, label, count, group]) => `${group ? `<div class="ng">${group}</div>` : ""}<div class="nl ${key === cur ? "cur" : ""}">${icon(key, 16)}${label}${count ? `<span class="cnt">${count}</span>` : ""}</div>`).join("");
  return `<div class="screen vd"><aside class="sb"><div class="wm"><i>S</i>Simlock</div><div class="find">${icon("search", 14)}Search<kbd>⌘K</kbd></div>${nav}
    <div class="me"><span class="av">OP</span><div class="grow"><div class="mono ell" style="font-size:12px">tok_262f…d582</div><div style="color:var(--ok);font-size:11px">● connected</div></div>${icon("out", 14)}</div></aside>
    <main><div class="ph"><div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ""}</div><div class="pr">${right}</div></div>${body}</main></div>`;
}

function overview() {
  const kpi = (label, v, u) => `<div class="card kpi"><div class="lab">${label}</div><div class="row"><div class="big">${v}<small>${u}</small></div></div></div>`;
  const wall = W.map((w) => `<div class="wt ${w.tone === "ok" ? "" : w.tone}"><div class="nm ell">${w.n}</div>${w.tone === "ok" ? "" : `<div>${pill(w.tone, w.word)}</div>`}
    <div class="row" style="gap:8px">${w.ios.length + w.and.length > 10 ? slotsCap(w.ios + w.and) : `${slots(w.ios)}<span style="width:1px;height:12px;background:var(--bd2)"></span>${slots(w.and)}`}</div><div style="display:grid;gap:4px;margin-top:auto">${m3(w)}</div></div>`).join("");
  const cap = (name, pct, l, t) => `<div class="row" style="gap:12px">${rbox(pct, 52)}<div><div style="font-weight:600">${name}</div><div class="mu" style="font-size:12px">${l} of ${t} leased</div></div></div>`;
  const q = [["#1", "codex/pr-1447-forms", "iPhone 16 · 18.4", "41 s"], ["#2", "ci/ui-shard-4", "iPhone 16 · 18.4", "22 s"], ["#3", "claude-code/widget-fix", "Pixel 9 · 15", "6 s"]];
  const body = `
  <div class="card hero"><div class="ib">3</div><div class="grow"><div style="font-weight:600;font-size:13.5px">3 things need you</div><div class="mu ell" style="font-size:12.5px">Szymons-MacBook-Pro.local disconnected 14 min ago · and 2 more</div></div><span class="btn sm pri">Open Inbox</span></div>
  <div class="g" style="grid-template-columns:repeat(6,1fr)">${kpi("Leased", 19, "/ 40")}${kpi("Ready", 12, "warm")}${kpi("Waiting", 3, "max 41 s")}${kpi("Wait p95", "4.2", "s")}${kpi("Ending soon", 2, "< 5 min")}${kpi("Workers", 7, "/ 8")}</div>
  <div class="g" style="grid-template-columns:1fr 340px;flex:1;min-height:0">
    <div class="g" style="grid-template-rows:auto 1fr">
      <div class="card"><div class="chd"><span class="lab">Fleet</span><span class="r">8 workers · ■ leased &nbsp;<span style="color:var(--ok)">■</span> ready &nbsp;▫ free</span><span class="btn sm" style="margin-left:10px">Open fleet</span></div><div class="wall" style="grid-template-columns:repeat(4,1fr)">${wall}</div></div>
      <div class="card"><div class="chd"><span class="lab">Leases held</span>${pill("plain", "now 19")}<span class="r">peak 23 at 17:52</span></div><div style="padding:6px 14px 2px">${area(series(7, 40, 16, 4, 0.1), 804, 200, { max: 28, smooth: true })}</div></div>
    </div>
    <div class="g" style="grid-template-rows:auto 1fr">
      <div class="card"><div class="chd"><span class="lab">Capacity</span></div><div style="padding:14px;display:grid;gap:12px">${cap("iOS", 46, 13, 28)}${cap("Android", 50, 6, 12)}</div></div>
      <div class="card"><div class="chd"><span class="lab">Queue</span><span class="r">3 waiting · p95 4.2 s</span></div>
        ${q.map((r) => `<div class="item" style="border-top:0;border-bottom:1px solid var(--bd)"><span class="mono mu">${r[0]}</span>${av(r[1])}${who(r[1], "ell grow")}<span class="mono" style="width:36px;text-align:right">${r[3]}</span></div>`).join("")}
        <div class="chd" style="height:34px"><span class="lab">Ending soon</span><span class="r">2 under 5 min</span></div>
        ${[["release-bot", "iPhone 14 · phone-rack-01", "02:36", 17], ["ci-nightly", "Pixel 8 · mac-mini-ci-01", "04:12", 28]].map((r) => `<div class="item" style="border-top:0;border-bottom:1px solid var(--bd)">${av(r[0])}<div class="grow" style="min-width:0"><div style="font-size:12.5px">${who(r[0], "ell")}</div><div class="mu ell" style="font-size:11.5px">${r[1]}</div></div><span style="width:110px">${ttl(r[2], r[3])}</span></div>`).join("")}
        <div style="padding:10px 14px 4px;margin-top:auto"><div class="lab" style="margin-bottom:6px">Requests waiting · 1 h</div>${bars(series(11, 40, 2.2, 2.4), 310, 44, { gap: 3, hot: [39] })}</div></div>
    </div>
  </div>`;
  return shell("overview", "Overview", "updated 18:18:04", range, body);
}

function fleet() {
  const bad = W.filter((w) => w.tone !== "ok"), good = W.filter((w) => w.tone === "ok");
  const reason = { disconnected: "last seen 14 min ago · 2 leases orphaned", drained: "1 lease left · accepts no new requests", "disk 91%": "481 GiB used of 526 · baselines 24 GB" };
  const bigCard = (w) => `<div class="card fc ${w.tone}"><div class="row" style="gap:10px"><div class="grow"><div class="nm ell">${w.n}</div><div class="mu" style="font-size:12px">${w.os} · simlock ${w.ver}</div></div>${pill(w.tone, w.word)}</div>
    <div class="mu clamp2" style="font-size:12.5px">${reason[w.word] || `seen ${w.seen}`}</div>
    <div class="row" style="gap:10px"><span class="lab" style="width:52px">iOS</span>${slotsCap(w.ios)}<span class="lab" style="width:52px;margin-left:12px">Android</span>${slotsCap(w.and)}</div>
    <div class="row" style="gap:14px">${["cpu", "mem", "disk"].map((k) => `<span class="mc grow"><span class="lab" style="width:28px">${k}</span>${meter(w[k], loadTone(w[k]))}<b>${w[k] ? w[k] + "%" : "—"}</b></span>`).join("")}</div>
    <div class="row" style="gap:8px;margin-top:2px"><span class="btn sm">${w.word === "drained" ? "Undrain" : w.word === "disconnected" ? "Release leases" : "Open"}</span><span class="btn sm">Details</span><span class="mu" style="margin-left:auto;font-size:12px">${w.leases} lease${w.leases === 1 ? "" : "s"}</span></div></div>`;
  const smallCard = (w) => `<div class="card fc" style="padding:12px 14px;gap:10px"><div class="row" style="gap:8px"><span class="nm ell grow" style="font-size:12.5px">${w.n}</span><span class="frac">${w.leases} / ${w.ios.length + w.and.length}</span></div>
    <div class="row" style="gap:6px">${w.ios.length + w.and.length > 10 ? slotsCap(w.ios + w.and) : `${slots(w.ios)}<span style="width:1px;height:12px;background:var(--bd2);margin:0 2px"></span>${slots(w.and)}`}</div>
    <div style="display:grid;gap:5px" class="wt-m">${m3(w)}</div>
    <div class="row mu" style="font-size:11.5px;gap:8px"><span>${w.leases} lease${w.leases === 1 ? "" : "s"}</span><span>·</span><span>${w.os}</span><span style="margin-left:auto">${icon("dots", 14)}</span></div></div>`;
  const body = `<div class="row" style="gap:8px">${seg(["All", "Issues", "Busy"])}<div class="find" style="height:30px;width:240px;margin:0">${icon("search", 14)}Filter workers</div></div>
  <div class="gh">Needs attention <span class="n">3</span></div><div class="g" style="grid-template-columns:repeat(3,1fr)">${bad.map(bigCard).join("")}</div>
  <div class="gh" style="margin-top:4px">Healthy <span class="n">5</span></div><div class="g" style="grid-template-columns:repeat(5,1fr)">${good.map(smallCard).join("")}</div>
  <div class="g" style="flex:1;min-height:0;margin-top:4px">
    <div class="card"><div class="chd"><span class="lab">Worker events</span>${pill("ok", "live")}<span class="r">last hour · 12</span></div>
      ${[["18:16:20", "warn", "worker.drain-started", "mbp-lab-03", "by tok_262f…d582"], ["18:13:58", "err", "worker.disconnected", "Szymons-MacBook-Pro.local", "no heartbeat for 30 s"], ["18:09:11", "warn", "worker.disk-high", "mac-mini-ci-02", "91% used, threshold 90%"], ["17:52:40", "ok", "worker.connected", "phone-rack-01", "simlock 0.6.0 · 1 physical device"], ["17:41:05", "", "worker.heartbeat-slow", "mac-mini-ci-03", "2.4 s round trip"]].map((e) => `<div class="log ${e[1] === "err" || e[1] === "warn" ? e[1] : ""}" style="grid-template-columns:70px 14px 190px 220px 1fr"><span class="mu">${e[0]}</span>${sq(e[1])}<span>${e[2]}</span><span>${e[3]}</span><span class="mu">${e[4]}</span></div>`).join("")}</div>
  </div>`;
  return shell("fleet", "Fleet", "", `<span class="btn pri">Add worker</span>`, body);
}

function worker() {
  const w = W[0];
  const g = (label, pct, big, small, tone = "") => `<div class="card" style="flex-direction:row;align-items:center;gap:14px;padding:12px 14px">${rbox(pct, 54, tone)}<div class="grow"><div class="lab">${label}</div><div style="font-size:17px;font-weight:600;letter-spacing:-.02em;margin-top:2px" class="ell">${big}</div><div class="mu" style="font-size:11.5px" class="ell">${small}</div></div></div>`;
  const dev = (d) => `<div class="wt dv" style="gap:10px;padding:14px"><div><div style="font-weight:500;font-size:13px" class="ell">${d[0]}</div><div class="row" style="gap:8px"><span class="mono mu grow" style="font-size:11px">${d[1]}</span>${pill(d[3] === "R" ? "ok" : d[4] ? "plain" : "", d[2])}</div></div>
    ${d[4] ? `<div class="row" style="gap:8px">${av(d[4])}${who(d[4], "ell grow", "font-size:12px")}</div>${ttl(d[5], d[6])}<div class="row" style="gap:8px;margin-top:auto"><span class="btn sm">Watch</span><span class="mu" style="margin-left:auto;font-size:11.5px">granted 18:03</span></div>` : `<div class="mu" style="font-size:12px">warm, waiting for a lease</div><div style="height:22px"></div><div class="row" style="gap:8px;margin-top:auto"><span class="btn sm">Watch</span><span class="mu" style="margin-left:auto;font-size:11.5px">booted 17:52</span></div>`}</div>`;
  const body = `<div class="g" style="grid-template-columns:repeat(4,1fr)">${g("CPU", 62, "12 cores", "load 7.4")}${g("Memory", 71, "25.6 GiB used", "of 36 · pressure normal")}${g("Disk", 52, "481 GiB free", "of 926 GiB")}${g("Slots", 60, "6 of 10 leased", "2 ready · 2 free")}</div>
  <div class="g" style="grid-template-columns:280px 1fr;flex:1;min-height:0">
    <div class="card" style="padding:14px;gap:16px">
      <div><div class="lab" style="margin-bottom:8px">Slots</div><div style="display:grid;gap:8px"><div class="row" style="gap:10px"><span class="mu" style="width:56px">iOS</span>${slots(w.ios)}<span class="mono mu" style="margin-left:auto">4 / 6</span></div><div class="row" style="gap:10px"><span class="mu" style="width:56px">Android</span>${slots(w.and)}<span class="mono mu" style="margin-left:auto">2 / 4</span></div></div></div>
      <div><div class="lab" style="margin-bottom:8px">Host</div><div class="facts"><span>macOS</span><span class="mono">26.6.1</span><span>Xcode</span><span class="mono">27.0</span><span>simlock</span><span class="mono">0.6.0</span><span>Warm pool</span><span class="mono">2 iOS · 1 Android</span><span>Joined</span><span>12 days ago</span><span>Worker id</span><span class="mono wrap" style="font-size:11.5px">wrk_1792cb29-43ed-4f0a-9b7e-2c1d3e4f5a6b</span></div></div>
      <div><div class="lab" style="margin-bottom:8px">Baselines here</div><div style="display:grid;gap:6px;font-size:12.5px">${[["ios-18.4-iphone16", "8.1 GB"], ["ios-18.4-ipad-air", "7.6 GB"], ["android-35-pixel9", "5.3 GB"]].map((b) => `<div class="row"><span class="mono ell grow">${b[0]}</span><span class="mono mu">${b[1]}</span></div>`).join("")}</div></div></div>
    <div class="card"><div class="tabs"><span class="on">Devices</span><span>Warm pool</span></div>
      <div class="wall" style="grid-template-columns:repeat(4,1fr);flex:none;border-bottom:1px solid var(--bd)">${DEVICES.map(dev).join("")}</div>
      <div class="chd" style="height:34px"><span class="lab">Events on this worker</span>${pill("ok", "live")}</div>
      ${EVENTS.filter((e) => e[4] !== "gateway" && !e[1].startsWith("worker") && !e[1].startsWith("baseline")).slice(0, 7).map((e) => `<div class="log ${e[2] === "err" || e[2] === "warn" ? e[2] : ""}" style="grid-template-columns:70px 14px 170px 220px 1fr"><span class="mu">${e[0]}</span>${sq(e[2])}<span>${e[1]}</span>${who(e[3], "ell")}<span class="mu">${e[5]}</span></div>`).join("")}</div>
  </div>`;
  return shell("fleet", `<span class="crumb">Fleet /</span> mac-studio-01 <span style="vertical-align:3px;margin-left:6px">${pill("ok", "connected")}</span>`, "macOS 26.6.1 · simlock 0.6.0 · read 2 s ago", `<span class="btn">Drain</span><span class="btn" style="width:30px;padding:0">${icon("dots")}</span>`, body);
}

function leases(selected = true) {
  const rows = L.map((l) => [`<div class="who">${av(l[0])}${who(l[0], "", "font-weight:500")}</div>`, `<div class="who"><div><b>${l[1]}</b><small class="mono">${l[2]}</small></div></div>`, `<span class="mono mu ell">${l[4]}</span>`, ttl(l[6], l[7])]);
  const cols = [{ h: "Held by" }, { h: "Device", w: "170px" }, { h: "Worker", w: "150px" }, { h: "Expires in", w: "132px" }];
  const l = L[13];
  const ev = [["18:06:20", "Renewed", "ttl 15 min", ""], ["17:51:12", "Granted", "iPhone 16 on mac-mini-ci-02", "ok"], ["17:51:05", "Requested", "waited 7 s in the queue", ""]];
  const body = `<div class="row" style="gap:8px">${seg(["All", "Ending &lt; 5 min", "iOS", "Android"])}<div class="find" style="height:30px;width:290px;margin:0">${icon("search", 14)}Filter by holder, device, worker</div></div>
  <div class="g" style="grid-template-columns:1fr 420px;flex:1;min-height:0">
    <div class="card">${tbl(cols, rows, { sel: selected ? 13 : -1 })}<div class="chd" style="margin-top:auto;border-bottom:0;border-top:1px solid var(--bd);height:34px"><span class="mu" style="font-size:12px">1–14 of 19</span></div></div>
    ${selected ? `<div class="card"><div style="padding:14px">
        <div class="row" style="gap:10px"><span class="av cc" style="width:34px;height:34px;border-radius:10px;font-size:11px;align-self:flex-start">CC</span><div class="grow" style="min-width:0"><div class="lab">Lease</div><div class="mono wrap" style="font-size:14px;font-weight:600;line-height:1.3">${l[0]}</div></div><span class="btn sm" style="width:26px;padding:0;align-self:flex-start">${icon("x", 13)}</span></div>
        <div style="background:var(--sf2);border-radius:8px;padding:12px 14px;margin:14px 0 12px;display:flex;align-items:center;gap:14px"><span class="ringbox">${ring(53, 64, "", 6)}<span></span></span><div><div class="big" style="font-size:30px">${l[6]}</div><div class="mu" style="margin-top:4px;font-size:12px">of 15 min · renewed 58 s ago</div></div></div>
        <div class="row" style="gap:8px"><span class="btn sm">Watch</span><span class="btn sm">Copy id</span><span class="btn sm danger" style="margin-left:auto">Release</span></div></div>
      <div class="facts" style="padding:14px;border-top:1px solid var(--bd)"><span>Device</span><span>${l[1]} · ${l[2]}</span><span>Worker</span><span class="mono">${l[4]}</span><span>Granted</span><span>${l[5]} · 17:51:12</span><span>Token</span><span class="mono">tok_agent…91c4</span><span>Lease id</span><span class="mono wrap" style="font-size:11.5px">lse_04d1a7be-22c8-4f63-9a1e-7b3c2d1e0f9a</span><span>Device id</span><span class="mono wrap" style="font-size:11.5px">dev_8164e29d-92af-4ad2-b06e-1a2b3c4d5e6f</span><span>Baseline</span><span class="mono">ios-18.4-iphone16</span></div>
      <div class="chd" style="height:32px;border-top:1px solid var(--bd);border-bottom:0"><span class="lab">Recent events</span></div>
      ${ev.map((e) => `<div class="fe"><span class="ico ${e[3]}">${icon("leases", 13)}</span><span class="ell"><b style="font-weight:500">${e[1]}</b> <span class="mu">· ${e[2]}</span></span><span class="mono mu" style="font-size:11.5px">${e[0]}</span></div>`).join("")}</div>` : `<div class="card"><div class="chd"><span class="lab">By holder</span><span class="r">19 leases</span></div><div style="padding:12px 14px;display:grid;gap:9px">${[["claude-code", 7], ["codex", 5], ["ci-nightly", 4], ["cursor", 3]].map((a) => `<div class="row" style="gap:10px">${av(a[0] + ":")}<span class="mono ell" style="width:96px;font-size:12px">${a[0]}</span>${meter(Math.round((a[1] / 19) * 100))}<span class="mono mu" style="width:20px;text-align:right;font-size:12px">${a[1]}</span></div>`).join("")}</div>
      <div class="chd" style="border-top:1px solid var(--bd)"><span class="lab">By platform</span></div><div style="padding:12px 14px;display:grid;grid-template-columns:1fr 1fr;gap:12px">${[["iOS", 46, 13, 28], ["Android", 50, 6, 12]].map((c) => `<div class="row" style="gap:10px">${rbox(c[1], 46, "", 5)}<div><div style="font-weight:600">${c[0]}</div><div class="mu" style="font-size:11.5px">${c[2]} of ${c[3]} slots</div></div></div>`).join("")}</div>
      <div class="chd" style="border-top:1px solid var(--bd)"><span class="lab">Ending in 5 min</span>${pill("warn", "2")}</div>
      ${[["release-bot", "iPhone 14 · phone-rack-01", "02:36", 17], ["ci-nightly", "Pixel 8 · mac-mini-ci-01", "04:12", 28]].map((r) => `<div class="item" style="border-top:0;border-bottom:1px solid var(--bd)">${av(r[0])}<div class="grow" style="min-width:0"><div style="font-size:12.5px">${who(r[0], "ell")}</div><div class="mu ell" style="font-size:11.5px">${r[1]}</div></div><span style="width:104px">${ttl(r[2], r[3])}</span></div>`).join("")}
      <div class="chd" style="border-top:1px solid var(--bd)"><span class="lab">Longest held</span></div>
      ${[["release-bot", "1 h 4 min", "renewed 9×"], ["ci-nightly", "52 min", "renewed 4×"], ["claude-code/push-optin", "40 min", "renewed 3×"]].map((r) => `<div class="item" style="border-top:0;border-bottom:1px solid var(--bd)">${av(r[0])}${who(r[0], "ell grow", "font-size:12.5px")}<span class="mu" style="font-size:11.5px">${r[2]}</span><span class="mono" style="width:76px;text-align:right;white-space:nowrap">${r[1]}</span></div>`).join("")}
      <div class="mu" style="margin-top:auto;padding:12px 14px;font-size:12px;border-top:1px solid var(--bd)">Select a lease to see its details and events here.</div></div>`}</div>`;
  return shell("leases", "Leases", "", "", body);
}


function streaming() {
  const l = L[0];
  const phone = `<div class="phone"><div class="scrn"><div class="notch"></div><div class="sbar"><span>18:17</span><span>●●● ▲ ▮</span></div>
      <div class="appbar">Checkout</div>
      <div class="fld">Email<b>ada@example.com</b></div><div class="fld">Card<b>•••• 4242</b></div><div class="fld">Expiry<b>12 / 29</b></div><div class="fld">Postcode<b>|</b></div>
      <div class="cta">Pay $42.00</div><div class="cur"></div>
      <div style="margin-top:auto;padding:0 16px 14px;color:#888;font-size:11px;text-align:center">Secured by Stripe</div></div></div>`;
  const stat = (k, v) => `<div style="white-space:nowrap"><div class="lab">${k}</div><div class="mono" style="font-size:12.5px;margin-top:2px">${v}</div></div>`;
  const body = `<div class="g" style="grid-template-columns:1fr 400px;flex:1;min-height:0">
    <div class="card" style="position:relative;padding:18px;justify-content:center;background:radial-gradient(ellipse at 50% 40%,#17171a 0%,var(--sf) 70%)">
      <span class="ov" style="left:18px;top:18px"><i></i>LIVE · 30 fps</span><span class="ov" style="right:18px;top:18px">h264 · 720×1560 · 1.4 Mb/s</span>
      ${phone}
      <div style="display:none">${stat("Started", "18:16:02 · 3 min ago")}${stat("Painted", "5 412 frames")}${stat("Dropped", "0")}${stat("Capture", "simlock-screen-capture")}${stat("Via", "gateway → mac-studio-01")}</div></div>
    <div class="g" style="grid-template-rows:auto auto 1fr;min-height:0">
      <div class="card"><div style="padding:14px"><div class="row" style="gap:10px"><span class="av cc" style="width:34px;height:34px;border-radius:10px;font-size:11px;align-self:flex-start">CC</span><div class="grow" style="min-width:0"><div class="lab">Holder</div><div class="mono wrap" style="font-size:14px;font-weight:600;line-height:1.3">${l[0]}</div></div></div>
        <div style="background:var(--sf2);border-radius:8px;padding:10px 12px;margin:12px 0;display:flex;align-items:center;gap:12px"><span class="ringbox">${ring(99, 48, "", 5)}<span></span></span><div><div class="big" style="font-size:24px">${l[6]}</div><div class="mu" style="font-size:11.5px;margin-top:3px">of 15 min · renewed 12 s ago</div></div></div>
        <div class="row" style="gap:8px"><span class="btn sm">Copy lease id</span><span class="btn sm">Lease details</span><span class="btn sm danger" style="margin-left:auto">Release</span></div></div></div>
      <div class="card"><div class="chd"><span class="lab">Device</span><span class="r">dev_51c8…e07a</span></div><div class="facts" style="padding:12px 14px"><span>Model</span><span>iPhone 16 Pro · iOS 18.4</span><span>Mode</span><span>slim, except push</span><span>Baseline</span><span class="mono">ios-18.4-iphone16pro</span><span>Worker</span><span class="mono">mac-studio-01</span><span>Booted</span><span>18:14:48 · from baseline in 9 s</span></div></div>
      <div class="card" style="min-height:0"><div class="chd"><span class="lab">Recent events</span>${pill("ok", "live")}</div>
        ${[["18:17:42", "Granted", "iPhone 16 Pro · iOS 18.4", "ok"], ["18:17:40", "Requested", "waited 2 s in the queue", ""], ["18:14:48", "Device ready", "booted from baseline in 9 s", "ok"], ["18:14:39", "Device booting", "ios-18.4-iphone16pro", ""], ["18:03:10", "Released", "claude-code/pr-1402-cart · held 21 min", ""], ["17:42:06", "Granted", "claude-code/pr-1402-cart", "ok"]].map((e) => `<div class="fe"><span class="ico ${e[3]}">${icon("leases", 13)}</span><span class="ell"><b style="font-weight:500">${e[1]}</b> <span class="mu">· ${e[2]}</span></span><span class="mono mu" style="font-size:11.5px">${e[0]}</span></div>`).join("")}</div>
    </div></div>`;
  return shell("fleet", `<span class="crumb">Fleet / mac-studio-01 /</span> iPhone 16 Pro <span style="vertical-align:3px;margin-left:6px">${pill("ok", "streaming")}</span>`, "iOS 18.4 · watching since 18:16:02", `<span class="btn">Stop watching</span><span class="btn" style="width:30px;padding:0">${icon("dots")}</span>`, body);
}

function baselines() {
  const row = (b) => [`<div class="who"><span class="av">${icon("baselines", 14)}</span><div class="grow"><b class="mono ell" style="font-size:12.5px">${b[0]}</b><small class="ell">${b[2]} · ${b[1] === "ios" ? "iOS" : "Android"} ${b[3]}</small></div></div>`, `<span class="mono">${b[4]}</span>`, `<span class="mono mu ell">${b[6]}</span>`, `<span class="mu">${b[7]}</span>`, `<div>${pill(b[8], b[9])}${b[10] ? `<div class="mu ell" style="font-size:11.5px;margin-top:3px">${b[10]}</div>` : ""}</div>`, more];
  const cols = [{ h: "Baseline" }, { h: "Size", w: "90px" }, { h: "Worker", w: "160px" }, { h: "Built", w: "110px" }, { h: "State", w: "300px" }, { h: "", w: "48px", c: "act" }];
  const ios = BASELINES.filter((b) => b[1] === "ios"), and = BASELINES.filter((b) => b[1] === "android");
  const grp = (t) => [t, "", "", "", "", ""];
  const rows = [grp("iOS · 4 baselines · 25.4 GB"), ...ios.map(row), grp("Android · 5 baselines · 24.1 GB"), ...and.map(row)];
  const body = `<div class="row" style="gap:8px">${seg(["All", "Stale", "Building"])}<div class="find" style="height:30px;width:240px;margin:0">${icon("search", 14)}Filter baselines</div></div>
  <div class="card">${tbl(cols, rows, { rowCls: (i) => (i === 0 || i === 5 ? "grp" : "") })}</div>
  <div class="card" style="flex:none"><div class="chd"><span class="lab">Disk used by baselines</span><span class="r">49.5 GB on 4 workers · share of each disk</span></div><div style="padding:12px 14px;display:grid;grid-template-columns:1fr 1fr;gap:10px 28px">${[["mac-studio-01", 12.6, 926], ["mac-studio-02", 17.5, 926], ["mac-mini-ci-01", 13.6, 526], ["mac-mini-ci-02", 5.8, 526]].map((r) => `<div class="row" style="gap:10px"><span class="mono ell" style="width:120px;font-size:12px">${r[0]}</span>${meter(Math.max(2, Math.round((r[1] / r[2]) * 100)))}<span class="mono mu" style="width:118px;text-align:right;font-size:11.5px;white-space:nowrap">${r[1]} GB of ${r[2]}</span></div>`).join("")}</div></div>
  <div style="display:none">
    <div class="card"><div class="chd"><span class="lab">Builds, last 7 days</span><span class="r">14 built · 1 failed</span></div><div style="padding:12px 14px 10px">${bars(series(23, 28, 2, 1.5), 358, 70, { gap: 4, hot: [27] })}</div><div class="mu" style="padding:0 14px 12px;font-size:12px">Median build <span class="mono" style="color:var(--tx)">3 min 40 s</span> · longest <span class="mono" style="color:var(--tx)">11 min 02 s</span> (ios-18.4-ipadair11)</div></div>
    <div class="card"><div class="chd"><span class="lab">Runtimes without a baseline</span><span class="r">cold boots</span></div>${[["iOS 17.5 · iPhone 15", "mac-mini-ci-02", "stale, rebuild"], ["iOS 18.3 · physical", "phone-rack-01", "n/a"], ["Android 14 · Pixel 8", "mac-studio-01", "build"]].map((r) => `<div class="item" style="border-top:0;border-bottom:1px solid var(--bd)"><span class="ell grow">${r[0]}<span class="mu"> · ${r[1]}</span></span>${r[2] === "n/a" ? `<span class="mu" style="font-size:11.5px">physical</span>` : `<span class="btn sm">${r[2] === "build" ? "Build" : "Rebuild"}</span>`}</div>`).join("")}</div>
  </div>`;
  return shell("baselines", "Baselines", "49.5 GB on 4 workers", `<span class="btn pri">Build baseline</span>`, body);
}

function activity() {
  const ic = (name) => (name.startsWith("lease") ? "leases" : name.startsWith("queue") ? "queue" : name.startsWith("device") ? "phone" : name.startsWith("worker") ? "fleet" : "baselines");
  const fe = (e) => `<div class="fe" style="grid-template-columns:26px 190px 1fr 140px 70px"><span class="ico ${e[2] === "idle" ? "" : e[2]}">${icon(ic(e[1]), 13)}</span><span class="mono ell" style="font-weight:500;font-size:12px">${e[1]}</span><span class="ell">${who(e[3])} <span class="mu">· ${e[5]}</span></span><span class="mono mu ell" style="font-size:11.5px">${e[4]}</span><span class="mono mu" style="font-size:11.5px;text-align:right">${e[0]}</span></div>`;
  const fac = (name, n, on = true) => `<div class="fac"><span class="bx ${on ? "on" : ""}">${on ? icon("check", 9) : ""}</span>${name}<span class="n">${n}</span></div>`;
  const body = `<div class="g" style="grid-template-columns:230px 1fr;flex:1;min-height:0">
    <div class="card"><div class="chd"><span class="lab">Kind</span></div><div style="padding:6px 0">${fac("Leases", 218)}${fac("Queue", 97)}${fac("Devices", 64)}${fac("Workers", 12)}${fac("Baselines", 21)}</div>
      <div class="chd" style="border-top:1px solid var(--bd)"><span class="lab">State</span></div><div style="padding:6px 0">${fac("Problems only", 9, false)}</div>
      <div class="chd" style="border-top:1px solid var(--bd)"><span class="lab">Worker</span></div><div style="padding:6px 0">${W.slice(0, 6).map((w, i) => fac(`<span class="mono ell" style="font-size:12px">${w.n}</span>`, [141, 96, 88, 41, 19, 14][i])).join("")}</div></div>
    <div class="card"><div style="padding:10px 14px 8px;border-bottom:1px solid var(--bd)"><div class="row" style="margin-bottom:6px"><span class="lab">Events per minute</span>${pill("ok", "live")}<span class="mu" style="margin-left:auto;font:11.5px 'Geist Mono'">412 in the last hour · peak 19 at 17:52</span></div>${bars(series(31, 90, 7, 6), 914, 46, { hot: [89] })}</div>
      ${EVENTS.slice(0, 18).map(fe).join("")}</div></div>`;
  return shell("activity", "Activity", "newest first", `<div class="find" style="height:30px;width:280px;margin:0">${icon("search", 14)}Filter events</div>${range}`, body);
}

export const screens = [
  ["Overview", overview()], ["Fleet, grouped", fleet()], ["Worker page", worker()], ["Device, streaming", streaming()], ["Leases, nothing selected", leases(false)], ["Leases, one selected", leases()], ["Baselines", baselines()], ["Activity", activity()],
];
export const meta = {
  key: "D", name: "Deck",
  line: "B's control room wearing C's clothes. Dark, sidebar, worker wall and side inspector come from B; rounded cards with gutters, status pills, agent chips, ring gauges, the \"needs you\" banner and attention-first grouping come from C.",
  notes: ["Same density as B, read as easily as C", "Floating sidebar and gutters, as in C; no status footer", "Holder ids: middle ellipsis, chip only for a known tool prefix; slots above 10 become a bar", "Cut: KPI sparks, fleet chart, Groups/Table toggle, duplicate Events tabs, Screen tab, Rotate, key hints, invented baseline cards"],
};
