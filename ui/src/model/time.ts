const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// why: a negative duration, which a skewed timestamp can produce, shows as `0 s`.
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND)) * SECOND;
  if (total < MINUTE) return `${total / SECOND} s`;
  const units: readonly [number, string][] = [
    [DAY, "d"],
    [HOUR, "h"],
    [MINUTE, "min"],
    [SECOND, "s"],
  ];
  const first = units.findIndex(([size]) => total >= size);
  const parts: string[] = [];
  let rest = total;
  for (const [size, name] of units.slice(first, first + 2)) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0 || parts.length === 0) parts.push(`${count} ${name}`);
  }
  return parts.join(" ");
}

// why: a countdown reads as a clock, `14:56`, and `1:02:03` past the hour, so it ticks in place.
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND));
  const pad = (n: number) => String(n).padStart(2, "0");
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
