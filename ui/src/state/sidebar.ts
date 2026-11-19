import { useSyncExternalStore } from "react";

import { usePreferences } from "./services";

const WIDE_FROM = "(min-width: 1280px)";

const PHONE = "(max-width: 767.98px)";

function wideByDefault(): boolean {
  return typeof window.matchMedia !== "function" || window.matchMedia(WIDE_FROM).matches;
}

function onPhone(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches;
}

function watchPhone(change: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(PHONE);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}

// why: the operator decides the sidebar's width and every page keeps it; with no choice made, a
// window too narrow for the sidebar, a list and a drawer side by side starts it collapsed. The
// choice is read from the preferences, so the toggle and the Settings page always agree.
export function useSidebarChoice(): {
  readonly collapsed: boolean;
  readonly setCollapsed: (collapsed: boolean) => void;
} {
  const preferences = usePreferences();
  const saved = useSyncExternalStore(
    preferences.subscribe,
    preferences.sidebar,
    preferences.sidebar,
  );
  return {
    collapsed: saved === undefined ? !wideByDefault() : saved === "narrow",
    setCollapsed: (collapsed) => preferences.setSidebar(collapsed ? "narrow" : "wide"),
  };
}

// why: on a phone the sidebar is a menu that opens full width, so the shell draws it expanded
// whatever the desktop choice is; the choice itself, which Settings shows, stays as it was.
export function useSidebar(): { readonly collapsed: boolean; readonly toggle: () => void } {
  const choice = useSidebarChoice();
  const phone = useSyncExternalStore(watchPhone, onPhone, () => false);
  return {
    collapsed: choice.collapsed && !phone,
    toggle: () => choice.setCollapsed(!choice.collapsed),
  };
}
