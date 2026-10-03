import type { ReactNode } from "react";

import { Id, PageHeader, Panel, StatCards } from "../layout";
import { useLiveResource, useNow } from "../live/live-context";
import { Loaded } from "../live/route-state";
import { formatDuration } from "../live/time";
import { Link } from "../router";
import { Status, type Tone } from "../status";
import { type Column, DataTable } from "../table";
import { type AttentionItem, attentionItems, attentionStats } from "./attention-model";
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
      <PageHeader
        title="Attention"
        subtitle="Workers and devices that need you, as the daemon reports them."
      />
      <Loaded state={state}>
        {(list) => {
          const items = attentionItems(list.workers);
          return (
            <>
              <StatCards stats={attentionStats(items)} />
              <Panel
                title="Needs attention"
                description="Each item leaves this list when the daemon reports it cleared."
              >
                <AttentionList items={items} now={now.server} />
              </Panel>
            </>
          );
        }}
      </Loaded>
    </section>
  );
}

/**
 * How many items need attention, for the count on the view's tab, on every page. `undefined`
 * before the first answer.
 */
export function useAttentionCount(): number | undefined {
  const { data } = useLiveResource<WorkerList>("/v1/workers");
  return data === undefined ? undefined : attentionItems(data.workers).length;
}

/**
 * One row per item, a page at a time, its condition first: the workers in the daemon's order,
 * each worker's own items before its devices'.
 */
export function AttentionList(props: {
  readonly items: readonly AttentionItem[];
  /** The daemon's time now, for how long a device has been stalled. */
  readonly now: number;
}) {
  const { items, now } = props;
  const columns: Column<AttentionItem>[] = [
    {
      cell: (item) => <Status tone={TONES[item.condition]}>{item.condition}</Status>,
      header: "Condition",
    },
    {
      cell: (item) => (
        <span>
          <Subject item={item} />: {describe(item, now)}
        </span>
      ),
      header: "Item",
    },
  ];
  return (
    <DataTable
      label="Needs attention"
      className="attention-table"
      rows={items}
      columns={columns}
      rowId={(item) => item.key}
      empty="Nothing needs attention."
    />
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
      Device <Id>{item.device.id}</Id> on {worker}
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
