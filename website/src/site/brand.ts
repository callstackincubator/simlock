// why: no other file may hard-code an accent hex, so the whole site, social card and icons follow
// these four values. The accent must be at least 4.5:1 on #0a0a0a and carry dark text; the docs
// need the two deeper light-mode colours because the bright accent is too pale on white.
export const accent = "#ff7a1a";
export const accentHover = "#ffb27a";
// why: must be at least 4.5:1 on white (this is 5.6:1, the console's --accent-text).
export const accentDeep = "#b93d0b";
export const accentRule = "#cb5f10";

const BG = "#0a0a0a";
const WHITE = "#ffffff";

export function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(a: string, b: string, t: number): string {
  const x = rgbOf(a);
  const y = rgbOf(b);
  return `#${x
    .map((c, i) =>
      Math.round(c + (y[i]! - c) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export const accentRgb = rgbOf(accent).join(" ");

export const brandCss = `:root{${Object.entries({
  "--accent": accent,
  "--accent-hover": accentHover,
  "--accent-rgb": accentRgb,
  "--accent-deep": accentDeep,
  "--accent-rule": accentRule,
  "--accent-low": mix(BG, accent, 0.2),
  "--accent-low-light": mix(WHITE, accent, 0.14),
  "--accent-high-light": mix(accentDeep, "#000000", 0.25),
})
  .map(([k, v]) => `${k}:${v}`)
  .join(";")}}`;
