export type ConsoleRange = "1h" | "6h" | "24h" | "7d";

export const RANGE_CHOICES: readonly { readonly value: ConsoleRange; readonly label: string }[] = [
  { label: "1 hour", value: "1h" },
  { label: "6 hours", value: "6h" },
  { label: "24 hours", value: "24h" },
  { label: "7 days", value: "7d" },
];

// why: the range lives in the URL as `?range=`, so a reload or a shared link shows the same figures;
// a value this console does not know is the default hour.
export function readRange(search: string): ConsoleRange {
  const asked = new URLSearchParams(search).get("range");
  return RANGE_CHOICES.find((choice) => choice.value === asked)?.value ?? "1h";
}

// why: any other key of the query (paging) is not the range's to touch, so only `range` is set or
// dropped.
export function writeRange(search: string, range: ConsoleRange): string {
  const params = new URLSearchParams(search);
  if (range === "1h") params.delete("range");
  else params.set("range", range);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

export function statsPath(range: ConsoleRange): `/v1/stats?since=${ConsoleRange}` {
  return `/v1/stats?since=${range}`;
}

const UNITS: Readonly<Record<ConsoleRange, string>> = {
  "1h": "last hour",
  "24h": "last 24 hours",
  "6h": "last 6 hours",
  "7d": "last 7 days",
};

export function rangeUnit(range: ConsoleRange): string {
  return UNITS[range];
}

// why: the Overview's Granted tile opens the Usage page on the range it shows, so the same figures
// are one click away; the default hour adds nothing to the path.
export function usagePath(range: ConsoleRange): string {
  return `/usage${writeRange("", range)}`;
}
