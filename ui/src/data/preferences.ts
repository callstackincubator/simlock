const SIDEBAR_KEY = "simlock.sidebar";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export type SidebarWidth = "wide" | "narrow";

export interface Preferences {
  sidebar(): SidebarWidth | undefined;
  setSidebar(width: SidebarWidth): void;
}

function attempt<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}

// why: a viewer's convenience, kept in the browser that chose it; a browser that refuses site data
// (or a value from elsewhere) leaves the choice to the window's width, and nothing breaks.
export function createPreferences(storage: () => Storage): Preferences {
  return {
    sidebar() {
      const saved = attempt(() => storage().getItem(SIDEBAR_KEY));
      return saved === "wide" || saved === "narrow" ? saved : undefined;
    },
    setSidebar(width) {
      attempt(() => storage().setItem(SIDEBAR_KEY, width));
    },
  };
}
