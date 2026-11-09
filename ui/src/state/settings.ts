import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { ApiError } from "../data/api";
import type { LoadView } from "../ds/loaded";
import { configSections, type ConfigSection, setCommand } from "../model/config-view";
import { setHolderStyle } from "../model/holder";
import {
  HOLDER_CHOICES,
  ROWS_CHOICES,
  SETTINGS_RANGE_CHOICES,
  THEME_CHOICES,
  type Settings,
} from "../model/settings";
import { useRouteQuery } from "./live";
import { loadView, mapView } from "./resource";
import { useNotify, usePreferences } from "./services";
import { useSidebarChoice } from "./sidebar";

export { HOLDER_CHOICES, ROWS_CHOICES, SETTINGS_RANGE_CHOICES, THEME_CHOICES };
export type { ConfigSection, Settings };

export function useSettings(): Settings {
  const preferences = usePreferences();
  return useSyncExternalStore(preferences.subscribe, preferences.settings, preferences.settings);
}

// why: the theme is an attribute of the page and the holder style a rule of the models, so both are
// set where the console starts and again at each change, before any page draws from them.
export function applySettings(settings: Settings): void {
  if (settings.theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", settings.theme);
  setHolderStyle(settings.holders);
}

export interface ConsoleSettings {
  readonly settings: Settings;
  readonly change: (patch: Partial<Settings>) => void;
  readonly sidebarCollapsed: boolean;
  readonly setSidebarCollapsed: (collapsed: boolean) => void;
}

export function useConsoleSettings(): ConsoleSettings {
  const preferences = usePreferences();
  const settings = useSettings();
  const sidebar = useSidebarChoice();
  return {
    change: (patch) => {
      preferences.change(patch);
      applySettings(preferences.settings());
    },
    setSidebarCollapsed: sidebar.setCollapsed,
    settings,
    sidebarCollapsed: sidebar.collapsed,
  };
}

export type DaemonSettings =
  | { readonly kind: "forbidden" }
  // why: a daemon older than this console has no such route.
  | { readonly kind: "older" }
  | { readonly kind: "view"; readonly view: LoadView<readonly ConfigSection[]> };

export function useDaemonSettings(): DaemonSettings {
  const state = useRouteQuery<Record<string, unknown>>("/v1/config");
  if (state.data === undefined && state.error instanceof ApiError && state.error.status === 403) {
    return { kind: "forbidden" };
  }
  if (state.data === undefined && state.error instanceof ApiError && state.error.status === 404) {
    return { kind: "older" };
  }
  return { kind: "view", view: mapView(loadView(state), configSections) };
}

const COPY_WAIT_MS = 3_000;
const COPY_FAILURE = "Couldn't copy.";

// why: a clipboard that is missing, refused or silent is a copy that did not happen, and the page
// says so, as Leases does.
export function useCopySetCommand(): (key: string, value: string) => void {
  const notify = useNotify();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return useCallback(
    (key, value) => {
      let settled = false;
      const settle = (copied: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (!live.current) return;
        notify(copied ? { title: "Copied" } : { title: COPY_FAILURE, tone: "error" });
      };
      const timer = window.setTimeout(() => settle(false), COPY_WAIT_MS);
      const clipboard = (navigator as { clipboard?: Clipboard }).clipboard;
      if (clipboard === undefined) {
        settle(false);
        return;
      }
      try {
        clipboard.writeText(setCommand(key, value)).then(
          () => settle(true),
          () => settle(false),
        );
      } catch {
        settle(false);
      }
    },
    [notify],
  );
}
