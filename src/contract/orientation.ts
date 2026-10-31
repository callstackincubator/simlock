// why: the four names a rotate takes over the contract and the input socket's `0x07` frame.
export const INPUT_ORIENTATIONS = [
  "portrait",
  "portrait_upside_down",
  "landscape_left",
  "landscape_right",
] as const;

export type ModelFamily = "phone" | "tablet" | "tv" | "watch" | "vision" | "unknown";

const MODEL_FAMILY_PREFIXES: readonly (readonly [string, ModelFamily])[] = [
  ["iPhone", "phone"],
  ["iPad", "tablet"],
  ["Apple TV", "tv"],
  ["Apple Watch", "watch"],
  ["Apple Vision", "vision"],
];

// why: every model the iOS driver lists starts with its product family's name, and the device record keeps only the model.
export function modelFamily(model: string): ModelFamily {
  return MODEL_FAMILY_PREFIXES.find(([prefix]) => model.startsWith(prefix))?.[1] ?? "unknown";
}

export function isRotatableModel(model: string): boolean {
  const family = modelFamily(model);
  return family === "phone" || family === "tablet";
}

export type Orientation = (typeof INPUT_ORIENTATIONS)[number];

export type OrientationParse =
  | { readonly ok: true; readonly orientation: Orientation }
  | { readonly ok: false; readonly message: string };

// why: the spellings `parseOrientation` accepts for a caller that takes more than the four names; HTTP and the client take only the four names.
const ALIASES: Readonly<Record<string, Orientation>> = {
  "landscape-left": "landscape_left",
  "landscape-right": "landscape_right",
  landscape_left: "landscape_left",
  landscape_right: "landscape_right",
  left: "landscape_left",
  portrait: "portrait",
  "portrait-upside-down": "portrait_upside_down",
  portrait_upside_down: "portrait_upside_down",
  right: "landscape_right",
  "upside-down": "portrait_upside_down",
};

export function parseOrientation(input: string): OrientationParse {
  const orientation = Object.hasOwn(ALIASES, input.trim().toLowerCase())
    ? ALIASES[input.trim().toLowerCase()]
    : undefined;
  if (orientation !== undefined) return { ok: true, orientation };
  return {
    message: `Unknown orientation ${input}; use portrait, portrait-upside-down, landscape-left or landscape-right`,
    ok: false,
  };
}
