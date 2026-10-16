import { type ReactNode, useId } from "react";

import { Facts, Id, Inspector, InspectorEmpty, Link, Loaded, Meter, Status } from "../../ds";
import { type LeaseInspection, useLeaseInspection } from "../../state/leases";
import { ScreenPanel } from "./screen-panel";

export function LeaseInspector({ id }: { readonly id: string }) {
  const view = useLeaseInspection(id);
  if (view.kind === "ready" && view.data === undefined) {
    return (
      <InspectorEmpty>
        Lease not found. <Link to="/leases">All leases</Link>
      </InspectorEmpty>
    );
  }
  if (view.kind !== "ready") {
    return (
      <section className="inspector">
        <Loaded view={view}>{() => null}</Loaded>
      </section>
    );
  }
  return (
    <Loaded view={view}>
      {(inspection) => (inspection === undefined ? null : <LeaseDetail lease={inspection} />)}
    </Loaded>
  );
}

export function LeaseDetail({ lease }: { readonly lease: LeaseInspection }) {
  return (
    <Inspector
      crumbs={[{ label: "Leases", to: "/leases" }, { label: lease.id }]}
      title={
        <span className="lease-title">
          {lease.title}
          {lease.expiring ? <Status tone="warn">expiring</Status> : null}
        </span>
      }
      mono
      line={<LeaseLine lease={lease} />}
    >
      <div className="lease-body">
        <div className="lease-cards">
          <ExpiryCard lease={lease} />
          <DeviceCard lease={lease} />
          <LeaseFactsCard lease={lease} />
        </div>
        <ScreenPanel
          leaseId={lease.id}
          offered={lease.stream.offered}
          reason={lease.stream.reason}
        />
      </div>
    </Inspector>
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
