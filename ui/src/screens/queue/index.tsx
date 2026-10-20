import "./queue.css";

import {
  type Column,
  DataTable,
  Drawer,
  Facts,
  focusAfterClosing,
  Id,
  Link,
  Loaded,
  Page,
  Refusal,
  StatRow,
  StatTile,
  Status,
  StatusDot,
} from "../../ds";
import { useItemId, useListDrawer } from "../../state/drawer";
import {
  useWaiting,
  type WaitingPage,
  type WaitingQueue,
  type WaitingRow,
} from "../../state/waiting";

export function QueueScreen() {
  const view = useWaiting();
  const urlId = useItemId("/queue");
  const { close, fromList } = useListDrawer("/queue", urlId);
  return (
    <Page
      title="Queue"
      actions={view.kind === "ready" ? <span className="muted">{view.data.meta}</span> : null}
    >
      <Loaded view={view}>
        {(page) => (
          <>
            <QueueBody page={page} />
            {urlId === undefined ? null : (
              <Drawer
                key={urlId}
                title={page.chosen?.requester ?? "Request"}
                onClose={close}
                finalFocus={() =>
                  focusAfterClosing({
                    fromList,
                    links: "main tbody a",
                    path: `/queue/${encodeURIComponent(urlId)}`,
                  })
                }
              >
                <QueueDrawerBody page={page} />
              </Drawer>
            )}
          </>
        )}
      </Loaded>
    </Page>
  );
}

export function QueueBody({ page }: { readonly page: WaitingPage }) {
  return (
    <>
      <WaitTile wait={page.wait} />
      <QueueTable page={page} />
    </>
  );
}

function WaitTile({ wait }: { readonly wait: WaitingPage["wait"] }) {
  if (wait.kind === "loading") return <p className="muted loaded-note">Loading…</p>;
  if (wait.kind === "refused") return <Refusal message={wait.message} />;
  if (wait.kind === "unsupported") return null;
  return (
    <>
      {wait.refusal === undefined ? null : <Refusal message={wait.refusal} />}
      <StatRow label="Waiting figures">
        <StatTile {...wait.data} />
      </StatRow>
    </>
  );
}

const COLUMNS: readonly Column<WaitingRow>[] = [
  { cell: (row) => row.place, header: "Place", mono: true },
  { cell: (row) => <Link to={row.to}>{row.requester}</Link>, header: "Requester", mono: true },
  { cell: (row) => row.device, header: "Device" },
  {
    cell: (row) => (
      <span className="queue-stage">
        <StatusDot tone={row.stage.tone} label={row.stage.word} />
        {row.stage.word}
      </span>
    ),
    header: "Stage",
  },
  { cell: (row) => row.why ?? "—", header: "Why" },
  { cell: (row) => row.waited, header: "Waited", mono: true },
];

function QueueTable({ page }: { readonly page: WaitingPage }) {
  return (
    <DataTable
      label="Waiting requests"
      rows={page.rows}
      columns={COLUMNS}
      rowId={(row) => row.key}
      rowTo={(row) => row.to}
      empty="No requests are waiting."
      paging={page.paging}
    />
  );
}

export function QueueDrawerBody({ page }: { readonly page: WaitingPage }) {
  const { chosen, gone } = page;
  if (gone || chosen === undefined)
    return <p className="muted queue-drawer">Request not waiting.</p>;
  return (
    <div className="queue-drawer">
      <Facts
        facts={[
          { label: "Waiting", value: chosen.waited },
          {
            label: "Place",
            value: (
              <>
                {chosen.placeOf}
                {chosen.physicalQueue ? <span className="muted"> · physical queue</span> : null}
              </>
            ),
          },
          { label: "Stage", value: <Status tone={chosen.stage.tone}>{chosen.stage.word}</Status> },
          { label: "Device", value: chosen.device },
          { label: "Queue", value: <QueueValue queue={chosen.queue} /> },
          ...(chosen.why === undefined ? [] : [{ label: "Why", value: chosen.why }]),
          ...(chosen.workers ?? []).map((worker) => ({ label: worker.name, value: worker.text })),
          { label: "Request", value: <Id>{chosen.id}</Id> },
          { label: "Created", value: chosen.created },
        ]}
      />
    </div>
  );
}

function QueueValue({ queue }: { readonly queue: WaitingQueue }) {
  if (queue.kind === "worker") return <Link to={queue.to}>{queue.name}</Link>;
  if (queue.kind === "unseen") return <Id>{queue.id}</Id>;
  return "the gateway's queue";
}
