import { useRef } from "react";

import type { Section } from "../model/paths";
import { navigate, useSearch } from "./router";

export interface ListDrawerState {
  readonly fromList: boolean;
  readonly close: () => void;
}

// why: the screen stays mounted from the list to an item, so an item that appears while it is
// mounted was opened from the list in this tab, and one present at the first render was loaded
// directly. Closing the first is a step back, so Back does not reopen it; the second has no list
// entry behind it, so closing replaces its address.
export function useListDrawer(section: Section, urlId: string | undefined): ListDrawerState {
  const mountedOpen = useRef(urlId !== undefined);
  if (urlId === undefined) mountedOpen.current = false;
  const fromList = !mountedOpen.current;
  const address = useSearch();
  return {
    close: () => {
      if (fromList) window.history.back();
      else navigate(`${section}${address}`, { replace: true });
    },
    fromList,
  };
}
