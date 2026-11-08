import "./streaming-page.css";

import {
  AgentChip,
  Button,
  Facts,
  Icon,
  Link,
  Loaded,
  Page,
  Panel,
  Pill,
  Ring,
  RowMenu,
  Status,
} from "../../ds";
import {
  agentKind,
  type DeviceRow,
  type LeaseInspection,
  useCopy,
  useDeviceEvents,
  useHolder,
  useLegacyWatchRedirect,
  useStreamingPage,
  type StreamingPageView,
} from "../../state/streaming";
import { ScreenPanel } from "./screen-panel";

export function StreamingPage(props: { readonly workerId: string; readonly deviceId: string }) {
  const { deviceId, workerId } = props;
  const view = useStreamingPage(workerId, deviceId);
  return (
    <Loaded view={view}>
      {(page) =>
        page === undefined ? (
          <Page title="Device">
            <p className="muted">
              This device is gone.{" "}
              <Link to={`/fleet/${encodeURIComponent(workerId)}`}>Back to the worker</Link>
            </p>
          </Page>
        ) : (
          <StreamingBody key={deviceId} page={page} workerId={workerId} />
        )
      }
    </Loaded>
  );
}

// why: an address from before this page, a device drawer opened on its Screen tab, lands here.
export function LegacyWatchRedirect(props: {
  readonly workerId: string;
  readonly deviceId: string | undefined;
}) {
  useLegacyWatchRedirect(props.workerId, props.deviceId);
  return null;
}

function StreamingBody(props: { readonly page: StreamingPageView; readonly workerId: string }) {
  const { page, workerId } = props;
  const { device, offer, worker } = page;
  const lease = device.lease;
  return (
    <div className="page stream-page">
      <header className="page-head">
        <div className="page-title">
          <div className="stream-title">
            <h1 tabIndex={-1} title={`${worker.name} / ${device.model}`}>
              <span className="stream-crumb">
                <Link to="/fleet">Fleet</Link> / <Link to={worker.to}>{worker.name}</Link> /
              </span>{" "}
              {device.model}
            </h1>
            {page.streaming ? (
              <Pill tone="ok">streaming</Pill>
            ) : (
              <Status tone={device.status.tone}>{device.status.word}</Status>
            )}
          </div>
          <span className="page-note">
            {device.platform} {device.runtime} · watching since {page.since}
          </span>
        </div>
        <div className="page-actions">
          <Button onClick={page.stop}>Stop watching</Button>
          <RowMenu
            label={`Actions for ${device.model}`}
            entries={[
              {
                danger: false,
                disabled: false,
                key: "device",
                label: "Device details",
                onSelect: page.details,
              },
              {
                danger: false,
                disabled: false,
                key: "worker",
                label: "Open worker",
                onSelect: page.stop,
              },
            ]}
          />
        </div>
      </header>
      <div className="stream-grid">
        <div className="stream-stage">
          <ScreenPanel
            workerId={workerId}
            deviceId={device.id}
            state={device.status.word}
            offer={offer}
          />
        </div>
        <div className="stream-side">
          {lease === undefined ? null : <HolderCard leaseId={lease.id} to={lease.to} />}
          <DeviceCard device={device} worker={worker.name} />
          <EventsCard workerId={workerId} deviceId={device.id} leaseId={lease?.id} />
        </div>
      </div>
    </div>
  );
}

function HolderCard(props: { readonly leaseId: string; readonly to: string }) {
  const { view, menu } = useHolder(props.leaseId);
  const copy = useCopy();
  if (view.kind !== "ready" || view.data === undefined) return null;
  const lease = view.data;
  const release = menu.entries.find((entry) => entry.danger);
  const holder = lease.holder?.id ?? lease.title;
  return (
    <section className="card stream-holder" aria-label="Holder">
      <div className="stream-holder-head">
        <AgentChip kind={agentKind(holder)} title={holder} />
        <div className="stream-holder-id">
          <p className="stream-label">Holder</p>
          <p className="stream-holder-name mono">{holder}</p>
        </div>
      </div>
      <Countdown lease={lease} />
      <div className="stream-holder-actions">
        <Button onClick={() => copy(lease.id, "Lease id")}>Copy lease id</Button>
        <Link className="button button-secondary" to={props.to}>
          Lease details
        </Link>
        {release === undefined ? null : (
          <Button className="stream-release" disabled={release.disabled} onClick={release.onSelect}>
            Release
          </Button>
        )}
      </div>
    </section>
  );
}

function Countdown({ lease }: { readonly lease: LeaseInspection }) {
  return (
    <div className="stream-countdown">
      <Ring
        bare
        label="Lease time left"
        size={48}
        tone={lease.expiring ? "warn" : "neutral"}
        {...(lease.percent === undefined ? {} : { percent: Math.round(lease.percent) })}
      />
      <div>
        <p className="stream-remaining mono" role="timer">
          {lease.remaining}
        </p>
        <p className="stream-renewed">renewed {lease.renewed}</p>
      </div>
    </div>
  );
}

function DeviceCard({ device, worker }: { readonly device: DeviceRow; readonly worker: string }) {
  return (
    <Panel
      title="Device"
      className="stream-panel"
      actions={<span className="mono muted">{device.id}</span>}
    >
      <Facts
        facts={[
          { label: "Model", value: `${device.model} · ${device.platform} ${device.runtime}` },
          ...(device.mode === undefined ? [] : [{ label: "Mode", value: device.mode }]),
          ...(device.baseline === undefined
            ? []
            : [{ label: "Baseline", value: <span className="mono">{device.baseline}</span> }]),
          { label: "Worker", value: <span className="mono">{worker}</span> },
          ...(device.since === undefined ? [] : [{ label: "In state for", value: device.since }]),
        ]}
      />
    </Panel>
  );
}

function EventsCard(props: {
  readonly workerId: string;
  readonly deviceId: string;
  readonly leaseId: string | undefined;
}) {
  const view = useDeviceEvents(props.workerId, props.deviceId, props.leaseId);
  return (
    <Panel
      title="Recent events"
      className="stream-events"
      actions={<Pill tone="ok">live</Pill>}
      flush
    >
      <Loaded view={view}>
        {({ rows }) =>
          rows.length === 0 ? (
            <p className="muted stream-none">No events for this device in the last hour.</p>
          ) : (
            <ul className="stream-event-list" aria-label="Events for this device">
              {rows.map((row) => (
                <li key={row.id} className="stream-event">
                  <span className={`stream-event-icon stream-event-${row.tone ?? "none"}`}>
                    <Icon name="leases" />
                  </span>
                  <span className="stream-event-text" title={`${row.title} · ${row.summary}`}>
                    <b>{row.title}</b> <span className="muted">· {row.summary}</span>
                  </span>
                  <time className="mono muted" dateTime={row.iso}>
                    {row.time}
                  </time>
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
    </Panel>
  );
}
