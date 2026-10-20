import { type ReactNode, useId } from "react";

import { Drawer, DrawerTabs, Facts, Id, Link, Loaded, Meter, Status } from "../../ds";
import {
  type EventRow,
  type LeaseInspection,
  useLeaseEvents,
  useLeaseInspection,
} from "../../state/leases";
import { ScreenPanel } from "./screen-panel";

// why: the drawer opens at once, titled "Lease" until the details arrive, and says so when
// the lease is no longer held, so an address that outlives its lease still lands somewhere.
export function LeaseDrawer(props: {
  readonly id: string;
  readonly onClose: () => void;
  readonly finalFocus: () => HTMLElement | null;
}) {
  const { finalFocus, id, onClose } = props;
  const view = useLeaseInspection(id);
  const lease = view.kind === "ready" ? view.data : undefined;
  return (
    <Drawer
      title={lease === undefined ? "Lease" : <LeaseTitle lease={lease} />}
      onClose={onClose}
      finalFocus={finalFocus}
    >
      {view.kind === "ready" && lease === undefined ? (
        <p className="muted drawer-note">This lease is not held.</p>
      ) : (
        <Loaded view={view}>
          {(inspection) =>
            inspection === undefined ? null : (
              <DrawerTabs
                defaultValue="details"
                label="Lease"
                tabs={[
                  {
                    content: <LeaseDetail lease={inspection} />,
                    label: "Details",
                    value: "details",
                  },
                  {
                    content: (
                      <ScreenPanel
                        leaseId={inspection.id}
                        offered={inspection.stream.offered}
                        reason={inspection.stream.reason}
                      />
                    ),
                    keepMounted: true,
                    label: "Screen",
                    value: "screen",
                  },
                  { content: <LeaseEvents id={inspection.id} />, label: "Events", value: "events" },
                ]}
              />
            )
          }
        </Loaded>
      )}
    </Drawer>
  );
}

function LeaseEvents({ id }: { readonly id: string }) {
  const view = useLeaseEvents(id);
  return <Loaded view={view}>{(rows) => <LeaseEventList rows={rows} />}</Loaded>;
}

export function LeaseEventList({ rows }: { readonly rows: readonly EventRow[] }) {
  if (rows.length === 0) return <p className="muted">No events for this lease in the last hour.</p>;
  return (
    <ul className="lease-events" aria-label="Events for this lease">
      {rows.map((row) => (
        <li key={row.id}>
          <time dateTime={row.iso} className="mono muted">
            {row.time}
          </time>
          <span className="mono">{row.name}</span>
          <span className="muted">{row.summary}</span>
        </li>
      ))}
    </ul>
  );
}

export function LeaseTitle({ lease }: { readonly lease: LeaseInspection }) {
  return (
    <span className="lease-title">
      {lease.title}
      {lease.expiring ? <Status tone="warn">expiring</Status> : null}
    </span>
  );
}

export function LeaseDetail({ lease }: { readonly lease: LeaseInspection }) {
  return (
    <div className="lease-cards">
      <p className="lease-line">
        <LeaseLine lease={lease} />
      </p>
      <ExpiryCard lease={lease} />
      <DeviceCard lease={lease} />
      <LeaseFactsCard lease={lease} />
    </div>
  );
}

function LeaseLine({ lease }: { readonly lease: LeaseInspection }) {
  const { worker } = lease;
  return (
    <>
      {lease.model}
      {lease.runtime === undefined ? "" : ` ${lease.runtime}`}
      {worker === undefined ? null : (
        <>
          {" on "}
          <WorkerName worker={worker} />
        </>
      )}
    </>
  );
}

function ExpiryCard({ lease }: { readonly lease: LeaseInspection }) {
  return (
    <LeaseCard title="Expires in">
      <p className={lease.expiring ? "lease-countdown lease-warn" : "lease-countdown"}>
        <span role="timer">{lease.remaining}</span>
      </p>
      {lease.percent === undefined ? null : (
        <Meter percent={lease.percent} tone={lease.expiring ? "warn" : "neutral"} />
      )}
      <dl className="lease-figures">
        <Figure label="Held for" value={lease.heldFor} />
        <Figure label="Renewed" value={lease.renewed} />
        <Figure label="Granted" value={lease.granted} />
      </dl>
    </LeaseCard>
  );
}

function DeviceCard({ lease }: { readonly lease: LeaseInspection }) {
  const { device, worker } = lease;
  return (
    <LeaseCard title="Device">
      <Facts
        facts={[
          { label: "Model", value: lease.model },
          { label: "Runtime", value: lease.runtime ?? "—" },
          { label: "Mode", value: device.mode ?? "—" },
          { label: "Image tag", value: <span className="mono">{device.imageTag ?? "—"}</span> },
          { label: "Kind", value: device.kind ?? "—" },
          { label: "Worker", value: worker === undefined ? "—" : <WorkerName worker={worker} /> },
          { label: "Device id", value: <Id>{device.deviceId}</Id> },
          { label: "UDID", value: <span className="mono">{device.udid}</span> },
        ]}
      />
    </LeaseCard>
  );
}

function LeaseFactsCard({ lease }: { readonly lease: LeaseInspection }) {
  return (
    <LeaseCard title="Lease">
      <Facts
        facts={[
          { label: "Lease id", value: <Id>{lease.id}</Id> },
          ...(lease.requestId === undefined
            ? []
            : [{ label: "Request", value: <span className="mono">{lease.requestId}</span> }]),
          { label: "Holder", value: <HolderName holder={lease.holder} /> },
          ...(lease.ownerId === undefined
            ? []
            : [{ label: "Owner", value: <span className="mono">{lease.ownerId}</span> }]),
        ]}
      />
    </LeaseCard>
  );
}

function HolderName({ holder }: { readonly holder: LeaseInspection["holder"] }) {
  if (holder === undefined) return <>—</>;
  if (holder.label === undefined) return <span className="mono">{holder.id}</span>;
  return (
    <>
      {holder.label} <span className="muted mono">{holder.id}</span>
    </>
  );
}

function WorkerName({ worker }: { readonly worker: NonNullable<LeaseInspection["worker"]> }) {
  return worker.to === undefined ? <>{worker.name}</> : <Link to={worker.to}>{worker.name}</Link>;
}

function LeaseCard(props: { readonly title: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <section className="card lease-card" aria-labelledby={id}>
      <h3 id={id} className="lease-card-title">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function Figure({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}
