import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// why: the ratios of every chip, pill and button pairing in both themes are plain arithmetic over
// the tokens in `foundation.css`, with many cases a browser lane would have to draw one by one.
const css = readFileSync(new URL("./foundation.css", import.meta.url), "utf8");

function tokens(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1]!, m[2]!]),
  );
}

// why: every colour a palette block sets, written as hex or as rgb()/rgba(), so a token missing from
// one block is seen whatever its notation.
function colours(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,8}|rgba?\([^;)]*\))\s*;/g)].map((m) => [
      m[1]!,
      m[2]!,
    ]),
  );
}

function between(start: string, end: string): string {
  const from = css.indexOf(start);
  return css.slice(from, css.indexOf(end, from));
}

const LIGHT = between("  /* Light theme. */", "/* The operator's own theme");
const DARK = between("@media (prefers-color-scheme: dark)", ':root[data-theme="dark"]');
const CHOSEN_DARK = between(':root[data-theme="dark"] {', "*,");
const light = tokens(LIGHT);
const dark = tokens(DARK);

function channel(hex: string, at: number): number {
  const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

function ratio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

const PAIRS: readonly (readonly [string, string, string])[] = [
  ["chip CC", "--agent-claude-code-text", "--agent-claude-code"],
  ["chip CX", "--agent-codex-text", "--agent-codex"],
  ["chip CU", "--agent-cursor-text", "--agent-cursor"],
  ["chip PI", "--agent-pi-text", "--agent-pi"],
  ["chip unknown", "--agent-unknown-text", "--agent-unknown"],
  ["pill plain", "--pill-plain-text", "--pill-plain-bg"],
  ["pill ok", "--pill-ok-text", "--pill-ok-bg"],
  ["pill warn", "--pill-warn-text", "--pill-warn-bg"],
  ["pill error", "--pill-error-text", "--pill-error-bg"],
  ["primary button", "--on-accent", "--accent"],
  ["primary button hover", "--on-accent", "--accent-hover"],
  ["secondary button", "--text", "--surface"],
  ["danger button", "--status-error", "--surface"],
  ["disabled button", "--text-muted", "--surface"],
  ["icon button", "--text", "--surface"],
  ["current nav link", "--accent-text", "--nav-current"],
  ["muted text on a band", "--text-muted", "--surface-2"],
];

describe("contrast", () => {
  for (const [name, theme] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`keeps every chip, pill and button at 4.5:1 or more in the ${name} theme`, () => {
      const table = PAIRS.map(([label, text, background]) => [
        label,
        Math.round(ratio(theme.get(text) ?? "#000000", theme.get(background) ?? "#ffffff") * 100) /
          100,
      ]);

      expect(table.filter(([, value]) => (value as number) < 4.5)).toEqual([]);
    });
  }
});

describe("the Settings theme", () => {
  it("themes every rule the system's dark mode changes through the palette, which data-theme overrides both ways", () => {
    const root = new URL("../", import.meta.url);
    const sheets = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".css"))
      .map((file) => [file, readFileSync(new URL(file, root), "utf8")] as const);
    const schemeBlocks = sheets.flatMap(([file, text]) =>
      [...text.matchAll(/@media\s*\(prefers-color-scheme:\s*(\w+)\)\s*\{\s*([^{]+?)\s*\{/g)].map(
        (m) => `${file}: ${m[1]} ${m[2]}`,
      ),
    );

    expect(schemeBlocks).toEqual([`ds/foundation.css: dark :root:not([data-theme="light"])`]);
    const [lightColours, darkColours] = [colours(LIGHT), colours(DARK)];
    expect(darkColours.get("--row-hover")).toMatch(/^rgba\(/);
    expect([...darkColours.keys()].filter((token) => !lightColours.has(token))).toEqual([]);
    expect(Object.fromEntries(colours(CHOSEN_DARK))).toEqual(Object.fromEntries(darkColours));
  });
});
