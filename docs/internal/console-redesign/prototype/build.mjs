import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { BASE_CSS } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../..");
const font = (p) => readFileSync(join(root, "node_modules/@fontsource-variable", p)).toString("base64");
const FONTS = `
@font-face{font-family:'Geist';font-weight:100 900;src:url(data:font/woff2;base64,${font("geist/files/geist-latin-wght-normal.woff2")}) format('woff2')}
@font-face{font-family:'Geist Mono';font-weight:100 900;src:url(data:font/woff2;base64,${font("geist-mono/files/geist-mono-latin-wght-normal.woff2")}) format('woff2')}`;

const Z = 0.62;
const want = process.argv.slice(2).length ? process.argv.slice(2) : ["d"];
const browser = await chromium.launch();
mkdirSync(join(here, "screens"), { recursive: true });
for (const key of want) {
  const v = await import(`./${key}.mjs`);
  const tiles = v.screens
    .map(([name, html], i) => `<figure><figcaption><b>${v.meta.key}${i + 1}</b> ${name}</figcaption><div class="frame"><div class="zoom">${html}</div></div></figure>`)
    .join("");
  const page_html = `<!doctype html><meta charset="utf-8"><title>Variant ${v.meta.key} — ${v.meta.name}</title><style>${FONTS}${BASE_CSS}${v.css}
  body{margin:0;background:#1c1c1e;color:#f2f2f0;font-family:'Geist',sans-serif;padding:32px;width:${Math.round(1440 * Z * 2 + 32 * 2 + 24)}px}
  body>h1{margin:0;font-size:30px;letter-spacing:-.02em;display:flex;align-items:center;gap:14px}
  body>h1>span{background:#f76b15;color:#111;padding:2px 10px;font-size:22px}
  .lead{color:#b5b5ba;font-size:16px;max-width:1100px;margin:10px 0 14px;line-height:1.5}
  .notes{display:flex;gap:10px;margin:0 0 24px;padding:0;list-style:none}
  .notes li{font:12.5px 'Geist Mono',monospace;color:#d6d6d0;border:1px solid #3a3a3f;padding:6px 10px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  figure{margin:0}
  figcaption{font:12px 'Geist Mono',monospace;color:#a1a1a8;margin-bottom:8px;letter-spacing:.04em}
  figcaption b{color:#f76b15;margin-right:6px}
  .frame{width:${1440 * Z}px;height:${900 * Z}px;overflow:hidden;outline:1px solid #3a3a3f}
  .zoom{zoom:${Z}}
  </style><h1><span>${v.meta.key}</span>${v.meta.name}</h1><p class="lead">${v.meta.line}</p><ul class="notes">${v.meta.notes.map((n) => `<li>${n}</li>`).join("")}</ul><div class="grid">${tiles}</div>`;
  const file = join(here, `variant-${key}.html`);
  writeFileSync(file, page_html);
  const page = await browser.newPage({ viewport: { width: 1900, height: 1000 }, deviceScaleFactor: 1.5 });
  await page.goto(`file://${file}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(here, `variant-${key}.png`), fullPage: true });
  await page.close();
  // why: full-size single screens, for checking detail the mosaic scales away.
  const one = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  for (const [i, [, html]] of v.screens.entries()) {
    await one.setContent(`<!doctype html><meta charset="utf-8"><style>${FONTS}${BASE_CSS}${v.css}body{margin:0}</style>${html}`);
    await one.evaluate(() => document.fonts.ready);
    await one.screenshot({ path: join(here, "screens", `${key}${i + 1}.png`) });
  }
  await one.close();
  console.log("wrote", file);
}
await browser.close();
