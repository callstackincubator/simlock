import type { ReactNode } from "react";

import { useLiveResource, useNow } from "../live/live-context";
import { Loaded } from "../live/route-state";
import { formatDuration } from "../live/time";
import { Link } from "../router";
import { Status, type Tone } from "../status";
import { type AttentionItem, attentionItems } from "./attention-model";
import {
  stateEnteredAt,
  type WorkerList,
  type WorkerView,
  workerName,
  workerPath,
} from "./workers-model";

/**
 * Everything that needs the operator's attention, in one list, fed by `GET /v1/workers`
 * (ADR 0013 §1) like the workers views. An item shows within a second of the daemon reporting
 * it and leaves when the daemon stops reporting it.
 */
export function AttentionView() {
  const state = useLiveResource<WorkerList>("/v1/workers");
  const now = useNow();
  return (
    <section className="view">
      <h1>Attention</h1>
      <Loaded state={state}>
        {(list) => <AttentionList items={attentionItems(list.workers)} now={now.server} />}
      </Loaded>
    </section>
  );
}

/**
 * How many items need attention, beside the view's name in the navigation, on every page.
 * Nothing while there are none, or before the first answer.
 */
export function AttentionCount() {
  const { data } = useLiveResource<WorkerList>("/v1/workers");
  if (data === undefined) return null;
  const count = attentionItems(data.workers).length;
  if (count === 0) return null;
  return (
    <span className="nav-count">
      {count}
      <span className="visually-hidden">{count === 1 ? " item" : " items"}</span>
    </span>
  );
}

export function AttentionList(props: {
  readonly items: readonly AttentionItem[];
  /** The daemon's time now, for how long a device has been stalled. */
  readonly now: number;
}) {
  const { items, now } = props;
  if (items.length === 0) return <p className="muted">Nothing needs attention.</p>;
  return (
    <ul className="attention-list">
      {items.map((item) => (
        <li key={item.key}>
          <Status tone={TONES[item.condition]}>{item.condition}</Status>
          <span>
            <Subject item={item} />: {describe(item, now)}
          </span>
        </li>
      ))}
    </ul>
  );
}

const TONES: Readonly<Record<AttentionItem["condition"], Tone>> = {
  disconnected: "error",
  drained: "warn",
  incompatible: "error",
  "over RAM budget": "warn",
  quarantined: "error",
  stalled: "warn",
};

/** The worker the item is about, as a link to its page, and the device when it is a device. */
function Subject({ item }: { readonly item: AttentionItem }) {
  const worker = <WorkerLink worker={item.worker} />;
  if (!("device" in item)) return worker;
  return (
    <>
      Device <span className="mono">{item.device.id}</span> on {worker}
    </>
  );
}

function WorkerLink({ worker }: { readonly worker: WorkerView }) {
  return <Link to={workerPath(worker.id)}>{workerName(worker)}</Link>;
}

function describe(item: AttentionItem, now: number): ReactNode {
  switch (item.condition) {
    case "disconnected":
      return "the gateway has lost its connection to this worker.";
    case "incompatible":
      return "this worker and the gateway have no protocol version in common.";
    case "drained":
      return "this worker gets no new leases.";
    case "over RAM budget":
      return `${gibibytes(item.usedBytes)} of ${gibibytes(item.limitBytes)} used.`;
    case "quarantined":
      return "Simlock is retrying its cleanup, and leases it to no one meanwhile.";
    case "stalled": {
      const since = stateEnteredAt(item.device, item.worker);
      return since === undefined
        ? `stuck ${item.device.state}.`
        : `stuck ${item.device.state} for ${formatDuration(now - since)}.`;
    }
  }
}

/** Bytes as `simlock status` writes its RAM budget: GiB with two decimals. */
function gibibytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
