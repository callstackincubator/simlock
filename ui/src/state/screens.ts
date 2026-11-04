import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { documentVisibility } from "../data/live/browser";
import { screenNotice, screensOf, type ScreenTile } from "../model/screens";
import type { WorkerList } from "../model/workers";
import { useConnection, useRouteQuery } from "./live";
import { loadView, mapView } from "./resource";

export type { ScreenTile } from "../model/screens";

export function useScreens() {
  const view = mapView(loadView(useRouteQuery<WorkerList>("/v1/workers")), (data) =>
    screensOf(data.workers),
  );
  const connection = useConnection();
  return { view, connected: connection.phase === "connected" };
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
