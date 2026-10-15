import type { LoadView } from "../ds/loaded";
import { ApiError } from "../data/api";
import type { ResourceState } from "../data/live/connection";

function isUnsupportedHere(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 501 && error.code === "UNSUPPORTED_IN_WORKER_MODE"
  );
}

function refusalOf(error: unknown): string {
  return error instanceof ApiError ? error.message : "The daemon's answer could not be read.";
}

// why: a route a single host does not answer (`501` `UNSUPPORTED_IN_WORKER_MODE`) is not an error
// there: the screen says it is not available, in place of its content.
export function loadView<T>(state: ResourceState<T>): LoadView<T> {
  const { data, error } = state;
  if (isUnsupportedHere(error)) return { kind: "unsupported" };
  if (data === undefined) {
    return error === undefined
      ? { kind: "loading" }
      : { kind: "refused", message: refusalOf(error) };
  }
  return error === undefined
    ? { data, kind: "ready" }
    : { data, kind: "ready", refusal: refusalOf(error) };
}

export function mapView<T, U>(view: LoadView<T>, map: (data: T) => U): LoadView<U> {
  if (view.kind !== "ready") return view;
  const data = map(view.data);
  return view.refusal === undefined
    ? { data, kind: "ready" }
    : { data, kind: "ready", refusal: view.refusal };
}

// why: a screen built from two routes shows nothing until both have answered; the first refusal
// wins, so the operator reads one reason rather than two.
export function bothViews<A, B>(a: LoadView<A>, b: LoadView<B>): LoadView<readonly [A, B]> {
  if (a.kind !== "ready") return a;
  if (b.kind !== "ready") return b;
  const refusal = a.refusal ?? b.refusal;
  const data = [a.data, b.data] as const;
  return refusal === undefined ? { data, kind: "ready" } : { data, kind: "ready", refusal };
}
