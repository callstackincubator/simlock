import {
  AgentChip,
  Button,
  ButtonLink,
  Drawer,
  Facts,
  FeedRow,
  Icon,
  Link,
  Loaded,
  Ring,
} from "../../ds";
import { IconButton } from "../../ds/button";
import {
  type EventRow,
  type LeaseInspection,
  useCopyLeaseId,
  useLeaseEvents,
  useLeaseInspector,
} from "../../state/leases";

// why: the lease's own words, shown where the page says what is open: the pane while the window is
// wide enough for it, a drawer below. An address that outlives its lease still lands here, and says
// so.
export function LeaseInspector(props: {
  readonly id: string;
  readonly onClose: () => void;
  readonly drawer?: { readonly finalFocus: () => HTMLElement | null };
}) {
  const { drawer, id, onClose } = props;
  const { release, view } = useLeaseInspector(id);
  const lease = view.kind === "ready" ? view.data : undefined;
  const body =
    view.kind === "ready" && lease === undefined ? (
      <p className="muted lease-note">This lease is not held.</p>
    ) : (
      <Loaded view={view}>
        {(inspection) =>
          inspection === undefined ? null : (
            <InspectorBody
              lease={inspection}
              onRelease={release?.onSelect}
              busy={release?.disabled}
            />
          )
        }
      </Loaded>
    );
  if (drawer !== undefined) {
    return (
      <Drawer
        title={lease === undefined ? "Lease" : lease.title}
        onClose={onClose}
        finalFocus={drawer.finalFocus}
      >
        {body}
      </Drawer>
    );
  }
  return (
    <section className="card lease-pane lease-inspector" aria-label="Lease">
      <header className="lease-head">
        <AgentChip kind={lease?.kind ?? "unknown"} />
        <div className="lease-head-text">
          <div className="lease-label">Lease</div>
          <div className="lease-name">{lease === undefined ? id : lease.title}</div>
        </div>
        <IconButton aria-label="Close lease" className="lease-close" onClick={onClose}>
          <Icon name="close" />
        </IconButton>
      </header>
      {body}
    </section>
  );
}

export function InspectorBody(props: {
  readonly lease: LeaseInspection;
  readonly onRelease: (() => void) | undefined;
  readonly busy: boolean | undefined;
}) {
  const { busy, lease, onRelease } = props;
  const copy = useCopyLeaseId();
  return (
    <>
      <div className="lease-top">
        <div className="lease-clock">
          <Ring
            size={64}
            stroke={6}
            showNumber={false}
            percent={lease.percent === undefined ? undefined : Math.round(lease.percent)}
            tone={lease.expiring ? "warn" : "neutral"}
          />
          <div>
            <div className={lease.expiring ? "lease-count lease-warn" : "lease-count"}>
              <span role="timer">{lease.remaining}</span>
            </div>
            <div className="muted lease-clock-note">
              {lease.ttl === undefined ? "" : `of ${lease.ttl} · `}renewed {lease.renewed}
            </div>
          </div>
        </div>
        <div className="lease-actions">
          {lease.watchTo === undefined ? null : (
            <ButtonLink to={lease.watchTo} className="button-sm">
              Watch
            </ButtonLink>
          )}
          <Button className="button-sm" onClick={() => copy(lease.id)}>
            Copy id
          </Button>
          {onRelease === undefined ? null : (
            <Button
              variant="danger"
              className="button-sm lease-release"
              disabled={busy === true}
              onClick={onRelease}
            >
              Release
            </Button>
          )}
        </div>
      </div>
      <LeaseFacts lease={lease} />
      <LeaseEvents id={lease.id} />
    </>
  );
}

export function LeaseFacts({ lease }: { readonly lease: LeaseInspection }) {
  const { device, worker } = lease;
  const facts = [
    {
      label: "Device",
      value: [lease.model, lease.runtime].filter((part) => part !== undefined).join(" · "),
    },
    {
      label: "Worker",
      value:
        worker === undefined ? (
          "—"
        ) : worker.to === undefined ? (
          <span className="mono">{worker.name}</span>
        ) : (
          <Link to={worker.to} className="mono">
            {worker.name}
          </Link>
        ),
    },
    { label: "Granted", value: `${lease.heldFor} ago · ${lease.granted}` },
    ...(lease.holder?.label === undefined
      ? []
      : [{ label: "Holder", value: <span className="mono lease-id">{lease.holder.id}</span> }]),
    ...(lease.token === undefined
      ? []
      : [{ label: "Token", value: <span className="mono lease-id">{lease.token}</span> }]),
    {
      label: "Lease id",
      value: (
        <span className="mono lease-id" title={lease.id}>
          {lease.id}
        </span>
      ),
    },
    {
      label: "Device id",
      value: (
        <span className="mono lease-id" title={device.deviceId}>
          {device.deviceId}
        </span>
      ),
    },
    ...(device.baseline === undefined
      ? []
      : [{ label: "Baseline", value: <span className="mono">{device.baseline}</span> }]),
  ];
  return (
    <div className="lease-facts">
      <Facts facts={facts} />
    </div>
  );
}

function LeaseEvents({ id }: { readonly id: string }) {
  const view = useLeaseEvents(id);
  return (
    <section className="lease-events" aria-label="Recent events">
      <h3 className="lease-label lease-events-title">Recent events</h3>
      <Loaded view={view}>{(rows) => <LeaseEventList rows={rows} />}</Loaded>
    </section>
  );
}

export function LeaseEventList({ rows }: { readonly rows: readonly EventRow[] }) {
  if (rows.length === 0) {
    return <p className="muted lease-note">No events for this lease in the last hour.</p>;
  }
  return (
    <ul className="lease-event-list" aria-label="Events for this lease">
      {rows.map((row) => (
        <li key={row.id}>
          <FeedRow
            icon={<Icon name="leases" />}
            event={row.name}
            subject={null}
            detail={<span className="muted">· {row.summary}</span>}
            tone={row.tone}
            worker={null}
            time={<time dateTime={row.iso}>{row.time}</time>}
          />
        </li>
      ))}
    </ul>
  );
}
