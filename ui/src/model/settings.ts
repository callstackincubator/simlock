import { RANGE_CHOICES, type ConsoleRange } from "./range";

export type Theme = "system" | "light" | "dark";
export type HolderStyle = "short" | "full";
export type RowsPerPage = 25 | 50 | 100;

export interface Settings {
  readonly theme: Theme;
  readonly range: ConsoleRange;
  readonly rows: RowsPerPage;
  readonly holders: HolderStyle;
}

export const SETTING_DEFAULTS: Settings = {
  holders: "short",
  range: "1h",
  rows: 25,
  theme: "system",
};

export const THEME_CHOICES: readonly { readonly value: Theme; readonly label: string }[] = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

export const ROWS_CHOICES: readonly { readonly value: `${RowsPerPage}`; readonly label: string }[] =
  [
    { label: "25", value: "25" },
    { label: "50", value: "50" },
    { label: "100", value: "100" },
  ];

export const HOLDER_CHOICES: readonly { readonly value: HolderStyle; readonly label: string }[] = [
  { label: "Short", value: "short" },
  { label: "Full", value: "full" },
];

export const SETTINGS_RANGE_CHOICES = RANGE_CHOICES.map((choice) => ({
  label: choice.value === "7d" ? "7 d" : choice.value.replace("h", " h"),
  value: choice.value,
}));

// why: a stored value is another window's, an older console's or a hand edit; each field that is
// not one of its known values is the default, and the rest of the object still counts.
export function readSettings(text: string | undefined): Settings {
  let found: unknown;
  try {
    found = text === undefined ? undefined : JSON.parse(text);
  } catch {
    found = undefined;
  }
  const object =
    typeof found === "object" && found !== null ? (found as Record<string, unknown>) : {};
  const { holders, range, rows, theme } = object;
  return {
    holders: holders === "short" || holders === "full" ? holders : SETTING_DEFAULTS.holders,
    range: RANGE_CHOICES.find((choice) => choice.value === range)?.value ?? SETTING_DEFAULTS.range,
    rows: rows === 25 || rows === 50 || rows === 100 ? rows : SETTING_DEFAULTS.rows,
    theme:
      theme === "light" || theme === "dark" || theme === "system" ? theme : SETTING_DEFAULTS.theme,
  };
}
