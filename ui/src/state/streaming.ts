import { useEffect, useState } from "react";

import type { LoadView } from "../ds/loaded";
import { type EventRow, eventRows } from "../model/event-list";
import { timeOfDay } from "../model/events";
import { readDrawerTab } from "../model/worker-page";
import { streamPath } from "../model/paths";
import { type StreamOffer, streamOffer, streamsDevice } from "../model/screen";
import { eventsOfDevice, eventTitle } from "../model/streaming";
import type { WorkerList } from "../model/workers";
import { workerPath } from "../model/workers";
import { useRecentEvents } from "./events";
import { type LeaseInspection, useLeaseDrawerMenu, useLeaseInspection } from "./leases";
import { useNow, useRouteQuery } from "./live";
import { loadView, mapView } from "./resource";
import { navigate, useSearch } from "./router";
import { type DeviceRow, useWorkerPage } from "./workers";

export type { DeviceRow, EventRow, LeaseInspection };
export { agentKind } from "../model/holder";
// why: the streaming page copies a lease id by the same rule, and with the same words, as Leases.
export { useCopyLeaseId } from "./leases";

export interface StreamingPageView {
  readonly worker: { readonly name: string; readonly to: string };
  readonly device: DeviceRow;
  readonly offer: StreamOffer;
  // why: the header says "streaming" only for a device whose picture is being asked for.
  readonly streaming: boolean;
  readonly details: () => void;
  // why: the clock time this page opened, which is when its capture started.
  readonly since: string;
  readonly stop: () => void;
}

// why: the page names a worker and a device by its address; a worker the fleet does not list, or a
// device the worker no longer lists, is `undefined` and the page says so.
export function useStreamingPage(
  workerId: string,
  deviceId: string,
): LoadView<StreamingPageView | undefined> {
  const page = useWorkerPage(workerId);
  const workers = useRouteQuery<WorkerList>("/v1/workers").data?.workers;
  const now = useNow();
  const [since] = useState(() => timeOfDay(now.server));
  return mapView(page, (shown) => {
    const device = shown?.overview.devices?.find((row) => row.id === deviceId);
    if (shown === undefined || device === undefined) return undefined;
    const to = workerPath(workerId);
    const offer = streamOffer(workers?.find((worker) => worker.id === workerId));
    return {
      details: () => navigate(device.to),
      device,
      offer,
      since,
      streaming: streamsDevice(device.status.word, offer),
      // why: Stop watching leaves the page, and leaving ends the capture, so there is nothing else to stop.
      stop: () => navigate(to),
      worker: { name: shown.title, to },
    };
  });
}

// why: an address from before the page existed, `?drawer=screen` on a device's drawer, lands on the
// page; the entry is replaced so Back does not return to the old address.
export function useLegacyWatchRedirect(workerId: string, deviceId: string | undefined): void {
  const search = useSearch();
  const legacy = deviceId !== undefined && readDrawerTab(search) === "screen";
  useEffect(() => {
    if (legacy) navigate(streamPath(workerId, deviceId), { replace: true });
  }, [legacy, workerId, deviceId]);
}

export interface HolderCard {
  readonly view: LoadView<LeaseInspection | undefined>;
  readonly menu: ReturnType<typeof useLeaseDrawerMenu>;
}

export function useHolder(leaseId: string): HolderCard {
  return { menu: useLeaseDrawerMenu(leaseId), view: useLeaseInspection(leaseId) };
}

export interface DeviceEvents {
  readonly rows: readonly (EventRow & { readonly title: string })[];
}

export function useDeviceEvents(
  workerId: string,
  deviceId: string,
  leaseId: string | undefined,
): LoadView<DeviceEvents> {
  const feed = useRecentEvents();
  const workers = useRouteQuery<WorkerList>("/v1/workers").data?.workers ?? [];
  return mapView(loadView(feed), (held) => ({
    rows: eventRows(eventsOfDevice(held, workerId, deviceId, leaseId), workers, "all")
      .slice(0, 12)
      .map((row) => ({ ...row, title: eventTitle(row.name) })),
  }));
}
