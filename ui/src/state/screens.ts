import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { documentVisibility } from "../data/live/browser";
import { SCREEN_CAPTURE_LIMIT } from "../model/screen";
import { screenNotice, screensOf, type ScreenTile } from "../model/screens";
import type { WorkerList } from "../model/workers";
import { useConnection, useRouteQuery } from "./live";
import { loadView, mapView } from "./resource";
import type { AcquireCapture } from "./screen";

export type { ScreenTile } from "../model/screens";
export type { AcquireCapture } from "./screen";

export function useScreens() {
  const [acquire] = useState(createCaptureBudget);
  const view = mapView(loadView(useRouteQuery<WorkerList>("/v1/workers")), (data) =>
    screensOf(data.workers),
  );
  const connection = useConnection();
  return { view, connected: connection.phase === "connected", acquire };
}

export function useScreenTile(tile: ScreenTile, connected: boolean) {
  const { target, active } = useScreenVisibility();
  return { target, notice: screenNotice({ active, connected, offer: tile.offer }) };
}

function useScreenVisibility() {
  const hidden = useSyncExternalStore(
    documentVisibility.subscribe,
    documentVisibility.hidden,
    () => true,
  );
  const [visible, setVisible] = useState(false);
  const observer = useRef<IntersectionObserver | undefined>(undefined);
  const target = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = undefined;
    setVisible(false);
    if (element === null) return;
    observer.current = new IntersectionObserver((entries) => {
      setVisible(entries.at(-1)?.isIntersecting ?? false);
    });
    observer.current.observe(element);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return { target, active: visible && !hidden };
}

// why: the page leaves room for data reads beside its event stream on HTTP/1. Aborting an owner
// removes its picture, but only completion of its reader's cleanup gives its place to another tile.
function createCaptureBudget(): AcquireCapture {
  let owners = 0;
  const waiting = new Set<() => void>();
  return (signal) =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve(undefined);
        return;
      }
      const cancel = () => {
        waiting.delete(admit);
        signal.removeEventListener("abort", cancel);
        resolve(undefined);
      };
      const admit = () => {
        if (owners >= SCREEN_CAPTURE_LIMIT) return;
        waiting.delete(admit);
        signal.removeEventListener("abort", cancel);
        owners++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          owners--;
          for (const next of waiting) next();
        });
      };
      waiting.add(admit);
      signal.addEventListener("abort", cancel, { once: true });
      admit();
    });
}
