import "./waiting.css";

import {
  Card,
  Empty,
  Facts,
  Grid,
  Id,
  Inspector,
  InspectorEmpty,
  Link,
  List,
  ListPane,
  ListRow,
  Loaded,
  MasterDetail,
  Pager,
  Refusal,
  StatRow,
  StatTile,
  Status,
  StatusDot,
} from "../../ds";
import {
  type WaitingPage,
  type WaitingQueue,
  type WaitingRow,
  useWaiting,
} from "../../state/waiting";

export function WaitingScreen() {
  const view = useWaiting();
  return <Loaded view={view}>{(page) => <WaitingBody page={page} />}</Loaded>;
}

export function WaitingBody({ page }: { readonly page: WaitingPage }) {
  const { chosen, gone, named, rows } = page;
  return (
    <MasterDetail
      focus={named ? "detail" : "list"}
      wide
      list={
        <ListPane
          title="Queue"
          meta={page.meta}
          footer={
            page.paging.total > page.paging.size ? (
              <Pager label="Waiting requests" paging={page.paging} />
            ) : undefined
          }
        >
          <WaitTile wait={page.wait} />
          {rows.length === 0 ? (
            <Empty>No requests are waiting.</Empty>
          ) : (
            <div className="waiting-list">
              <List label="Waiting requests">
                {rows.map((row) => (
                  <WaitingListRow key={row.key} row={row} selected={row === chosen} />
                ))}
              </List>
            </div>
          )}
        </ListPane>
      }
      detail={detailOf(chosen, gone)}
    />
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

function detailOf(chosen: WaitingRow | undefined, gone: boolean) {
  if (gone) {
    return (
      <InspectorEmpty>
        Request not waiting. <Link to="/queue">Back to Queue</Link>
      </InspectorEmpty>
    );
  }
  return chosen === undefined ? (
    <InspectorEmpty>Nothing to show.</InspectorEmpty>
  ) : (
    <WaitingInspector key={chosen.key} row={chosen} />
  );
}

function WaitingListRow({
  row,
  selected,
}: {
  readonly row: WaitingRow;
  readonly selected: boolean;
}) {
  return (
    <ListRow
      to={row.to}
      selected={selected}
      mono
      lead={<span className="waiting-place">{row.place}</span>}
      title={row.requester}
      aside={row.waited}
      sub={row.device}
      trail={
        <span className="waiting-stage">
          <StatusDot tone={row.stage.tone} label={row.stage.word} />
          {row.stage.word}
        </span>
      }
    />
  );
}

function WaitingInspector({ row }: { readonly row: WaitingRow }) {
  return (
    <Inspector
      crumbs={[{ label: "Queue", to: "/queue" }, { label: row.id }]}
      title={row.requester}
      mono
      line={`wants ${row.device}`}
    >
      <Grid min="sm">
        <Card>
          <p className="waiting-card-label">Waiting</p>
          <p className="waiting-card-value">{row.waited}</p>
        </Card>
        <Card>
          <p className="waiting-card-label">Place</p>
          <p className="waiting-card-value">{row.placeOf}</p>
          {row.physicalQueue ? <p className="waiting-card-note">physical queue</p> : null}
        </Card>
        <Card>
          <p className="waiting-card-label">Stage</p>
          <p className="waiting-card-value waiting-card-word">
            <Status tone={row.stage.tone}>{row.stage.word}</Status>
          </p>
        </Card>
      </Grid>
      <Facts
        facts={[
          { label: "Request", value: <Id>{row.id}</Id> },
          { label: "Created", value: row.created },
          { label: "Queue", value: <QueueValue queue={row.queue} /> },
          ...(row.why === undefined ? [] : [{ label: "Why", value: row.why }]),
          ...(row.workers ?? []).map((worker) => ({ label: worker.name, value: worker.text })),
        ]}
      />
    </Inspector>
  );
}

function QueueValue({ queue }: { readonly queue: WaitingQueue }) {
  if (queue.kind === "worker") return <Link to={queue.to}>{queue.name}</Link>;
  if (queue.kind === "unseen") return <Id>{queue.id}</Id>;
  return "the gateway's queue";
}
