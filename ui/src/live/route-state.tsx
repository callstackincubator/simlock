import type { ReactNode } from "react";

import { ApiError } from "../api";
import type { ResourceState } from "./connection";

/**
 * A view's data, or what to show instead: "Loading" before the first answer, and the daemon's
 * refusal when it refused. A route a single host does not answer (`501`
 * `UNSUPPORTED_IN_WORKER_MODE`) is not an error there: the view says it is not available.
 */
export function Loaded<T>(props: {
  readonly state: ResourceState<T>;
  readonly children: (data: T) => ReactNode;
}) {
  const { children, state } = props;
  if (state.error !== undefined) return <RouteRefusal error={state.error} />;
  if (state.data === undefined) return <p className="muted">Loading…</p>;
  return children(state.data);
}

function RouteRefusal({ error }: { readonly error: unknown }) {
  if (
    error instanceof ApiError &&
    error.status === 501 &&
    error.code === "UNSUPPORTED_IN_WORKER_MODE"
  ) {
    return <p className="muted">Not available on a single host.</p>;
  }
  const message =
    error instanceof ApiError ? error.message : "The daemon's answer could not be read.";
  return (
    <p className="refusal" role="alert">
      {message}
    </p>
  );
}
