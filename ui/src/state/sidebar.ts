import { useSyncExternalStore } from "react";

import { usePreferences } from "./services";

const WIDE_FROM = "(min-width: 1280px)";

function wideByDefault(): boolean {
  return typeof window.matchMedia !== "function" || window.matchMedia(WIDE_FROM).matches;
}

// why: the operator decides the sidebar's width and every page keeps it; with no choice made, a
// window too narrow for the sidebar, a list and a drawer side by side starts it collapsed. The
// choice is read from the preferences, so the toggle and the Settings page always agree.
export function useSidebar(): { readonly collapsed: boolean; readonly toggle: () => void } {
  const preferences = usePreferences();
  const saved = useSyncExternalStore(
    preferences.subscribe,
    preferences.sidebar,
    preferences.sidebar,
  );
  const collapsed = saved === undefined ? !wideByDefault() : saved === "narrow";
  return {
    collapsed,
    toggle: () => preferences.setSidebar(collapsed ? "wide" : "narrow"),
  };
}
