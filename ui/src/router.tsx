import { type AnchorHTMLAttributes, type MouseEvent, useSyncExternalStore } from "react";

/**
 * Real page URLs (`/workers`), not hashes (ADR 0011 §3): the daemon answers every path with no
 * file extension with the console's page, so a reload or a pasted link lands on the same view.
 */

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

/** The current path, re-rendering on every navigation and on the browser's back and forward. */
export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function navigate(to: string, options: { readonly replace?: boolean } = {}): void {
  if (options.replace === true) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  for (const listener of listeners) listener();
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick"> {
  readonly to: string;
}

const MODIFIER_KEYS = ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const;

/** A primary click with no modifier key: the browser would open the link in this tab. */
function opensInThisTab(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !MODIFIER_KEYS.some((key) => event[key]);
}

/** An ordinary link that navigates without a reload; a modified click still opens a new tab. */
export function Link({ to, ...rest }: LinkProps) {
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!opensInThisTab(event)) return;
    event.preventDefault();
    navigate(to);
  };
  return <a {...rest} href={to} onClick={follow} />;
}
