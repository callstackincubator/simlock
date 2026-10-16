import { useSyncExternalStore } from "react";

// why: the daemon answers every path with no file extension with the console's page, so a reload or
// a pasted link lands on the same view.

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

// why: empty where there is no page URL, as when a test renders a view to a string.
export function useSearch(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => "",
  );
}

// why: `replace` overwrites the history entry instead of adding one, for a correction the operator
// did not ask for.
export function setSearch(search: string, options: { readonly replace?: boolean } = {}): void {
  const { hash, pathname } = window.location;
  navigate(`${pathname}${search}${hash}`, options);
}

export function navigate(to: string, options: { readonly replace?: boolean } = {}): void {
  if (options.replace === true) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  for (const listener of listeners) listener();
}
