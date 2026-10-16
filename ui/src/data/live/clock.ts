// why: the browser's clock may differ from the daemon's, so every duration is measured against the
// daemon's time; a missing or bad `Date` header returns `undefined` and leaves the last good offset.
export function clockOffset(date: string | null, receivedAt: number): number | undefined {
  if (date === null) return undefined;
  const sent = Date.parse(date);
  return Number.isFinite(sent) ? sent - receivedAt : undefined;
}
