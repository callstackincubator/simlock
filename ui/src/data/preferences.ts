import { readSettings, type Settings } from "../model/settings";

const SIDEBAR_KEY = "simlock.sidebar";
const SETTINGS_KEY = "simlock.settings";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export type SidebarWidth = "wide" | "narrow";

export interface Preferences {
  sidebar(): SidebarWidth | undefined;
  setSidebar(width: SidebarWidth): void;
  // why: the console's other choices (Settings), one object that is the same value until a choice
  // changes it, so a component can subscribe to it.
  settings(): Settings;
  change(patch: Partial<Settings>): void;
  subscribe(listener: () => void): () => void;
}

function attempt<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}

// why: a viewer's convenience, kept in the browser that chose it; a browser that refuses site data
// (or a value from elsewhere) leaves the choice to the window's width, and nothing breaks. A
// choice a browser will not keep still holds until the page is closed.
export function createPreferences(storage: () => Storage): Preferences {
  const listeners = new Set<() => void>();
  let sidebar: SidebarWidth | undefined;
  let settings: Settings | undefined;
  let sidebarRead = false;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const read = (): Settings => {
    settings ??= readSettings(attempt(() => storage().getItem(SETTINGS_KEY)) ?? undefined);
    return settings;
  };
  return {
    change(patch) {
      const next = { ...read(), ...patch };
      settings = next;
      attempt(() => storage().setItem(SETTINGS_KEY, JSON.stringify(next)));
      notify();
    },
    setSidebar(width) {
      sidebar = width;
      sidebarRead = true;
      attempt(() => storage().setItem(SIDEBAR_KEY, width));
      notify();
    },
    settings: read,
    sidebar() {
      if (!sidebarRead) {
        const saved = attempt(() => storage().getItem(SIDEBAR_KEY));
        sidebar = saved === "wide" || saved === "narrow" ? saved : undefined;
        sidebarRead = true;
      }
      return sidebar;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
