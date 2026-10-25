import { useState } from "react";

import { usePreferences } from "./services";

const WIDE_FROM = "(min-width: 1280px)";

function wideByDefault(): boolean {
  return typeof window.matchMedia !== "function" || window.matchMedia(WIDE_FROM).matches;
}

// why: the operator decides the sidebar's width and every page keeps it; with no choice made, a
// window too narrow for the sidebar, a list and a drawer side by side starts it collapsed.
export function useSidebar(): { readonly collapsed: boolean; readonly toggle: () => void } {
  const preferences = usePreferences();
  const [collapsed, setCollapsed] = useState(() => {
    const saved = preferences.sidebar();
    return saved === undefined ? !wideByDefault() : saved === "narrow";
  });
  return {
    collapsed,
    toggle: () => {
      const next = !collapsed;
      preferences.setSidebar(next ? "narrow" : "wide");
      setCollapsed(next);
    },
  };
}
