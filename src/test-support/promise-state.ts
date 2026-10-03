/**
 * Test-only (excluded from the build): reads whether a promise has settled without awaiting it.
 *
 * A test that advances a fake clock past a deadline and then `await`s the promise the deadline
 * should have settled proves nothing when the timer is broken -- the `await` simply never
 * returns, and the test fails by timing out rather than on an assertion that names what went
 * wrong. Asserting `state` first, after letting microtasks run, turns that into a named failure
 * (`expected 'pending' to be 'rejected'`); the `await` that follows then only reads the value.
 */
export interface PromiseState {
  readonly state: "pending" | "fulfilled" | "rejected";
}

export function promiseState(promise: Promise<unknown>): PromiseState {
  const observed: { state: PromiseState["state"] } = { state: "pending" };
  promise.then(
    () => {
      observed.state = "fulfilled";
    },
    () => {
      observed.state = "rejected";
    },
  );
  return observed;
}
