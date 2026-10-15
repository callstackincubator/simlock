import type { ReactNode } from "react";

export type LoadView<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "ready"; readonly data: T; readonly refusal?: string };

// why: a refusal after earlier answers shows above the data kept from them, so an operator never
// loses what they were reading to a passing error.
export function Loaded<T>(props: {
  readonly view: LoadView<T>;
  readonly children: (data: T) => ReactNode;
}) {
  const { children, view } = props;
  if (view.kind === "loading") return <p className="muted loaded-note">Loading…</p>;
  if (view.kind === "unsupported") {
    return <p className="muted loaded-note">Not available on a single host.</p>;
  }
  if (view.kind === "refused") return <Refusal message={view.message} />;
  return (
    <>
      {view.refusal === undefined ? null : <Refusal message={view.refusal} />}
      {children(view.data)}
    </>
  );
}

export function Refusal({ message }: { readonly message: string }) {
  return (
    <p className="refusal" role="alert">
      {message}
    </p>
  );
}
