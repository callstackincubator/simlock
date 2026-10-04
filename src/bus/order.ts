/**
 * The one order every reader presents events in (ADR 0014 §5): by `timestamp`, then by `seq`
 * within a millisecond. Arrival order is not it: a gateway's relayed event carries the time it
 * happened on the worker, which can be earlier than events the gateway already holds.
 */
export function byTimeThenSeq(
  a: { readonly timestamp: number; readonly seq: number },
  b: { readonly timestamp: number; readonly seq: number },
): number {
  return a.timestamp - b.timestamp || a.seq - b.seq;
}
