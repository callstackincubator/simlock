const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function oneDecimal(value: number): string {
  const rounded = Math.floor(value * 10 + 0.5) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatBytes(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "?";
  return value < GIB ? `${oneDecimal(value / MIB)} MiB` : `${oneDecimal(value / GIB)} GiB`;
}

export function formatAge(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "?";
  if (value < 60_000) return `${Math.floor(value / 1_000)} s`;
  if (value < 3_600_000) return `${Math.floor(value / 60_000)} min`;
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

const MAX_PART = 300;

/** why: Slack reads `&`, `<` and `>` in text as markup, and `<!channel>` pings a channel. */
export function part(value: unknown): string {
  const points = Array.from(String(value));
  const cut = points.length > MAX_PART ? `${points.slice(0, MAX_PART).join("")}…` : points.join("");
  return cut.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
