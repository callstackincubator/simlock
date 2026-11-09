import "./fleet.css";

import {
  ButtonLink,
  ChoiceChips,
  Link,
  Loaded,
  type LoadView,
  LogRow,
  Page,
  Pill,
  SearchField,
  StatusDot,
  type WorkerTableGroup,
  WorkerTable,
} from "../../ds";
import {
  type FleetRow,
  type LogEventRow,
  type FleetPage,
  useFleet,
  useFleetAddress,
  useFleetEvents,
  useWorkerMenu,
  WORKER_FILTERS,
} from "../../state/workers";
import { StreamingPage, LegacyWatchRedirect } from "./streaming-page";
import { WorkerPageScreen } from "./worker-page";

export function FleetScreen() {
  const { deviceId, streaming, workerId } = useFleetAddress();
  if (workerId === undefined) return <FleetTable />;
  if (streaming === true && deviceId !== undefined) {
    return <StreamingPage workerId={workerId} deviceId={deviceId} />;
  }
  return (
    <>
      <LegacyWatchRedirect workerId={workerId} deviceId={deviceId} />
      <WorkerPageScreen id={workerId} deviceId={deviceId} />
    </>
  );
}

function FleetTable() {
  const view = useFleet();
  const log = useFleetEvents();
  return (
    <Page
      title="Fleet"
      actions={
        <ButtonLink variant="primary" to={ADD_WORKER_URL}>
          Add worker
        </ButtonLink>
      }
    >
      <Loaded view={view}>{(page) => <FleetBody page={page} log={log} />}</Loaded>
    </Page>
  );
}

const ADD_WORKER_URL = "https://callstackincubator.github.io/simlock/docs/gateway/joining-workers";

export function FleetBody({
  log,
  page,
}: {
  readonly page: FleetPage;
  readonly log: LoadView<{ readonly rows: readonly LogEventRow[] }>;
}) {
  const entries = useWorkerMenu();
  const none = page.attention.length === 0 && page.healthy.length === 0;
  return (
    <>
      <div className="fleet-controls">
        <ChoiceChips
          legend="Show workers"
          choices={WORKER_FILTERS}
          value={page.filter}
          onChange={page.setFilter}
        />
        <SearchField
          label="Search workers"
          placeholder="Filter workers"
          value={page.query}
          onChange={page.search}
        />
      </div>
      {none ? (
        <p className="muted">{page.empty ? "No workers have connected." : "No worker matches."}</p>
      ) : null}
      {none ? null : <WorkerTable groups={groups(page)} entries={entries} />}
      <Loaded view={log}>{(shown) => <FleetLog rows={shown.rows} />}</Loaded>
    </>
  );
}

function groups(page: FleetPage): readonly WorkerTableGroup<FleetRow>[] {
  return [
    {
      id: "attention" as const,
      label: `Needs attention ${page.attention.length}`,
      rows: page.attention,
    },
    { id: "healthy" as const, label: `Healthy ${page.healthy.length}`, rows: page.healthy },
  ].filter((group) => group.rows.length > 0);
}

function FleetLog({ rows }: { readonly rows: readonly LogEventRow[] }) {
  return (
    <section className="fleet-log" aria-label="Worker events">
      <header className="fleet-log-head">
        <h2 className="fleet-label">Worker events</h2>
        <Pill tone="ok">live</Pill>
        <span className="fleet-log-count">last hour · {rows.length}</span>
      </header>
      {rows.length === 0 ? (
        <p className="muted fleet-log-empty">No worker events in the last hour.</p>
      ) : (
        <ul className="fleet-log-list" aria-label="Worker events">
          {rows.map((row) => (
            <li key={row.id}>
              <LogRow
                time={<time dateTime={row.iso}>{row.time}</time>}
                status={
                  <StatusDot
                    tone={row.squareTone}
                    label={row.squareTone === "idle" ? "info" : row.squareTone}
                  />
                }
                event={<Link to={row.to}>{row.name}</Link>}
                subject={row.subject}
                detail={row.detail}
                {...(row.tone === undefined || row.tone === "ok" || row.tone === "idle"
                  ? {}
                  : { tone: row.tone })}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
