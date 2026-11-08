import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// why: the ratios of every chip, pill and button pairing in both themes are plain arithmetic over
// the tokens in `foundation.css`, with many cases a browser lane would have to draw one by one.
const css = readFileSync(new URL("./foundation.css", import.meta.url), "utf8");

function tokens(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1]!, m[2]!]),
  );
}

function between(start: string, end: string): string {
  const from = css.indexOf(start);
  return css.slice(from, css.indexOf(end, from));
}

const light = tokens(between("  /* Light theme. */", "/* The operator's own theme"));
const dark = tokens(between("@media (prefers-color-scheme: dark)", ':root[data-theme="dark"]'));

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
