import "./overview.css";

import {
  Empty,
  Link,
  Loaded,
  Meter,
  MinuteChart,
  MinuteTable,
  Page,
  Panel,
  Row,
  ShareBar,
  SlotLegend,
  Slots,
  StatRow,
  StatTile,
  Status,
  StatusDot,
} from "../../ds";
import {
  type Gauge,
  type Overview,
  type OverviewActivity,
  type OverviewItem,
  type OverviewWorker,
  type PlatformUse,
  useOverview,
} from "../../state/overview";

export function OverviewScreen() {
  const view = useOverview();
  return (
    <Page title="Overview">
      <Loaded view={view}>{(overview) => <OverviewBody overview={overview} />}</Loaded>
    </Page>
  );
}

export function OverviewBody({ overview }: { readonly overview: Overview }) {
  return (
    <>
      <StatRow label="Fleet at a glance">
        {overview.tiles.map((tile) => (
          <StatTile key={tile.label} {...tile} />
        ))}
      </StatRow>
      <Row>
        <Panel title="Leases held, last hour">
          <MinuteChart
            kind="area"
            title="Leases held, last hour"
            unit="leases held"
            minutes={overview.minutes}
          />
          <p className="chart-summary">{overview.chartSummary}</p>
          <MinuteTable minutes={overview.minutes} heading="Leases held" />
        </Panel>
        <Panel title="Capacity">
          <div className="capacity">
            {overview.platforms.map((platform) => (
              <PlatformBar key={platform.name} platform={platform} />
            ))}
            <SlotLegend />
          </div>
        </Panel>
      </Row>
      <Row>
        <Panel
          title="Workers"
          flush
          actions={<Link to="/workers">All {overview.workers.length}</Link>}
        >
          <WorkerTable workers={overview.workers} />
        </Panel>
        <div className="overview-side">
          <Panel title="Attention" flush>
            <AttentionList items={overview.attention} />
          </Panel>
          <Panel title="Activity" flush actions={<Link to="/events">All events</Link>}>
            <ActivityList rows={overview.activity} />
          </Panel>
        </div>
      </Row>
    </>
  );
}

function PlatformBar({ platform }: { readonly platform: PlatformUse }) {
  return (
    <div className="platform">
      <p className="platform-head">
        <span>{platform.name}</span>
        <span className="mono">
          {platform.running} <span className="muted">of {platform.limit} running</span>
        </span>
      </p>
      <ShareBar
        shares={[
          { kind: "leased", percent: platform.leasedPercent },
          { kind: "ready", percent: platform.readyPercent },
          { kind: "busy", percent: platform.busyPercent },
        ]}
      />
    </div>
  );
}

function GaugeCell({ gauge }: { readonly gauge: Gauge | undefined }) {
  if (gauge === undefined) return <span className="gauge muted">—</span>;
  return (
    <span className="gauge">
      <Meter percent={gauge.percent} tone={gauge.tone} size="thin" />
      <span className="mono">{gauge.text}</span>
    </span>
  );
}

function WorkerTable({ workers }: { readonly workers: readonly OverviewWorker[] }) {
  if (workers.length === 0) return <Empty>No workers have connected.</Empty>;
  return (
    <table className="table worker-table">
      <thead>
        <tr>
          <th scope="col">Worker</th>
          <th scope="col">Devices</th>
          <th scope="col">CPU</th>
          <th scope="col">Memory</th>
          <th scope="col" className="num">
            Leases
          </th>
        </tr>
      </thead>
      <tbody>
        {workers.map((worker) => (
          <tr key={worker.id}>
            <td data-label="Worker">
              <span className="worker-name">
                <StatusDot tone={worker.health.tone} label={worker.health.word} />
                <Link to={worker.to}>{worker.name}</Link>
              </span>
            </td>
            <td data-label="Devices">
              <Slots slots={worker.slots} label={worker.slotsLabel} />
            </td>
            <td data-label="CPU">
              <GaugeCell gauge={worker.cpu} />
            </td>
            <td data-label="Memory">
              <GaugeCell gauge={worker.memory} />
            </td>
            <td data-label="Leases" className="num">
              {worker.leases}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AttentionList({ items }: { readonly items: readonly OverviewItem[] }) {
  if (items.length === 0) return <Empty>Nothing needs attention.</Empty>;
  return (
    <ul className="overview-list">
      {items.map((item) => (
        <li key={item.key}>
          <Link to={item.to} className="overview-row">
            <Status tone={item.tone}>{item.word}</Status>
            <span className="overview-row-aside">{item.subject}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ActivityList({ rows }: { readonly rows: readonly OverviewActivity[] }) {
  if (rows.length === 0) return <Empty>No events in the last hour.</Empty>;
  return (
    <ul className="overview-list">
      {rows.map((row) => (
        <li key={row.key}>
          <Link to={row.to} className="overview-row activity-row">
            <span className="mono muted">{row.time}</span>
            <span className={row.tone === undefined ? "mono" : `mono event-${row.tone}`}>
              {row.name}
            </span>
            <span className="activity-text">{row.text}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
