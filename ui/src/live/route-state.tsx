import type { ReactNode } from "react";

import { ApiError } from "../api";
import type { ResourceState } from "./connection";

/**
 * A view's data, or what to show instead: "Loading" before the first answer, and the daemon's
 * refusal when it refused. A refusal after earlier answers shows above the data kept from them.
 * A route a single host does not answer (`501` `UNSUPPORTED_IN_WORKER_MODE`) is not an error
 * there: the view says it is not available, in place of its content.
 */
export function Loaded<T>(props: {
  readonly state: ResourceState<T>;
  readonly children: (data: T) => ReactNode;
}) {
  const { children, state } = props;
  const { data, error } = state;
  if (isUnsupportedHere(error)) return <p className="muted">Not available on a single host.</p>;
  if (data === undefined) {
    return error === undefined ? <p className="muted">Loading…</p> : <Refusal error={error} />;
  }
  return (
    <>
      {error === undefined ? null : <Refusal error={error} />}
      {children(data)}
    </>
  );
}

function isUnsupportedHere(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 501 && error.code === "UNSUPPORTED_IN_WORKER_MODE"
  );
}

function Refusal({ error }: { readonly error: unknown }) {
  const message =
    error instanceof ApiError ? error.message : "The daemon's answer could not be read.";
  return (
    <p className="refusal" role="alert">
      {message}
    </p>
  );
}
