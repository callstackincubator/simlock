/** why: Lets an awaited renewal settle; the fake clock never moves on its own. */
export async function flushMicrotasks(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}
