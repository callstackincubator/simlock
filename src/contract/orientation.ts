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
