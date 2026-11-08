import "./overview.css";

import {
  AgentChip,
  Banner,
  Bars,
  ButtonLink,
  ChoiceChips,
  Link,
  Loaded,
  Meter,
  MinuteChart,
  MinuteTable,
  Page,
  Panel,
  Pill,
  Refusal,
  Ring,
  SlotLegend,
  Slots,
  StatRow,
  StatTile,
  WorkerTile,
} from "../../ds";
import { type ConsoleRange, RANGE_CHOICES, useRange } from "../../state/range";
import type { FiguresState } from "../../state/figures";
import {
  type EndingCard,
  type Overview,
  type PlatformCapacity,
  type QueueCard,
  type WallWorker,
  useOverview,
} from "../../state/overview";

type Unavailable = { readonly unavailable: string };
type FigureChart = Extract<FiguresState, { kind: "ready" }>["data"]["charts"][number];

// why: the header filter is compact, so its words are the short forms of the range's own.
function shortRange(value: ConsoleRange): string {
  return value.replace(/^(\d+)([hd])$/, "$1 $2");
}

const SHORT_RANGES = RANGE_CHOICES.map((choice) => ({
  label: shortRange(choice.value),
  value: choice.value,
}));

export function OverviewScreen() {
  const [range, setRange] = useRange();
  const view = useOverview(range);
  const updated = view.kind === "ready" ? view.data.updated : undefined;
  return (
    <Page
      title="Overview"
      {...(updated === undefined ? {} : { note: `updated ${updated}` })}
      actions={
        <ChoiceChips legend="Range" choices={SHORT_RANGES} value={range} onChange={setRange} />
      }
    >
      <Loaded view={view}>
        {(overview) => <OverviewBody overview={overview} range={range} />}
      </Loaded>
    </Page>
  );
}

export function OverviewBody(props: {
  readonly overview: Overview;
  readonly range?: ConsoleRange;
}) {
  const { overview, range = "1h" } = props;
  const { banner, figures } = overview;
  const ready = figures.kind === "ready" ? figures : undefined;
  const leases = ready?.data.charts.find((chart) => chart.key === "leasesHeld");
  const queued = ready?.data.charts.find((chart) => chart.key === "queueDepth");
  return (
    <>
      {banner === undefined ? null : (
        <Banner
          count={banner.count}
          title={banner.title}
          detail={
            <span className="overview-banner-detail">
              <Link to={banner.first.to}>{banner.first.text}</Link>
              {banner.more === 0 ? "" : ` · and ${banner.more} more`}
            </span>
          }
          action={
            <ButtonLink to="/inbox" variant="primary" small>
              Open Inbox
            </ButtonLink>
          }
        />
      )}
      {ready?.refusal === undefined ? null : <Refusal message={ready.refusal} />}
      {figures.kind === "refused" ? <Refusal message={figures.message} /> : null}
      {ready?.data.note === undefined ? null : <p className="muted">{ready.data.note}</p>}
      <StatRow label="Fleet at a glance">
        {overview.tiles.map((tile) => (
          <StatTile key={tile.label} {...tile} />
        ))}
      </StatRow>
      <div className="overview-grid">
        <div className="overview-main">
          <Panel
            title="Fleet"
            flush
            actions={
              <>
                <span className="overview-meta overview-fleet-meta">
                  {overview.workers.length} workers ·
                  <SlotLegend kinds={["leased", "ready", "free"]} />
                </span>
                <ButtonLink to="/fleet" small>
                  Open fleet
                </ButtonLink>
              </>
            }
          >
            {overview.workers.length === 0 ? (
              <p className="empty">No workers have connected.</p>
            ) : (
              <ul className="overview-wall">
                {overview.workers.map((worker) => (
                  <li key={worker.key}>
                    <Tile worker={worker} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <LeasesHeld chart={leases} figures={figures} />
        </div>
        <div className="overview-side">
          <Panel title="Capacity">
            <div className="overview-capacity">
              {overview.capacity.map((platform) => (
                <Capacity key={platform.name} platform={platform} />
              ))}
            </div>
          </Panel>
          <Panel
            title="Queue"
            flush
            className="overview-queue"
            actions={
              <span className="overview-meta">
                {"meta" in overview.queue ? overview.queue.meta : ""}
              </span>
            }
          >
            <QueueList queue={overview.queue} />
            <section className="overview-sub" aria-label="Ending soon">
              <h3 className="overview-sub-title">Ending soon</h3>
              <span className="overview-meta">
                {"meta" in overview.ending ? overview.ending.meta : ""}
              </span>
            </section>
            <EndingList ending={overview.ending} />
            <div className="overview-waiting">
              <h3 className="overview-sub-title">Requests waiting · {shortRange(range)}</h3>
              {queued === undefined ? (
                <p className="muted">
                  {figures.kind === "refused" ? "Not available." : "Loading…"}
                </p>
              ) : (
                <>
                  <Bars values={queued.points.map((point) => point.count)} label={queued.title} />
                  <p className="visually-hidden">{queued.summary}</p>
                  <MinuteTable
                    minutes={queued.points}
                    heading={queued.heading}
                    bucketMs={queued.bucketMs}
                  />
                </>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

function meterOf(worker: WallWorker, label: string) {
  const found = worker.meters.find((meter) => meter.label === label);
  return { percent: found?.percent, tone: found?.tone ?? "neutral" } as const;
}

// why: past ten slots the wall shows one capped meter for the worker, not a row of squares per platform.
function slotsOf(worker: WallWorker) {
  if (worker.ios.length + worker.android.length > 10) {
    return {
      android: undefined,
      ios: <Slots slots={[...worker.ios, ...worker.android]} label={worker.slotsLabel} />,
    };
  }
  return {
    android: <Slots slots={worker.android} label={`Android: ${worker.slotsLabel}`} />,
    ios: <Slots slots={worker.ios} label={`iOS: ${worker.slotsLabel}`} />,
  };
}

function Tile({ worker }: { readonly worker: WallWorker }) {
  const cpu = meterOf(worker, "CPU");
  const memory = meterOf(worker, "Memory");
  const disk = meterOf(worker, "Disk");
  const { tone, word } = worker.health;
  const issue = tone === "ok" ? undefined : <Pill tone={tone}>{word}</Pill>;
  return (
    <WorkerTile
      name={worker.name}
      title={worker.name}
      to={worker.to}
      tone={tone === "ok" ? "neutral" : tone}
      pill={issue}
      {...slotsOf(worker)}
      cpu={cpu.percent}
      memory={memory.percent}
      disk={disk.percent}
      cpuTone={cpu.tone}
      memoryTone={memory.tone}
      diskTone={disk.tone}
    />
  );
}

function LeasesHeld(props: {
  readonly chart: FigureChart | undefined;
  readonly figures: FiguresState;
}) {
  const { chart, figures } = props;
  if (chart === undefined) {
    return (
      <Panel title="Leases held">
        <p className="muted">{figures.kind === "refused" ? "Not available." : "Loading…"}</p>
      </Panel>
    );
  }
  return (
    <Panel
      title="Leases held"
      className="overview-chart"
      lead={
        chart.now === undefined ? undefined : (
          <Pill tone="idle" plain>
            {chart.now}
          </Pill>
        )
      }
      actions={
        chart.peak === undefined ? undefined : <span className="overview-meta">{chart.peak}</span>
      }
    >
      <MinuteChart
        kind="area"
        title={chart.title}
        unit={chart.unit}
        minutes={chart.points}
        height="100%"
        tickGap={100}
      />
      <p className="visually-hidden">{chart.summary}</p>
      <MinuteTable minutes={chart.points} heading={chart.heading} bucketMs={chart.bucketMs} />
    </Panel>
  );
}

function Capacity({ platform }: { readonly platform: PlatformCapacity }) {
  const percent =
    platform.total === 0 ? undefined : Math.round((platform.leased / platform.total) * 100);
  return (
    <div className="overview-ring">
      <Ring
        bare
        size={52}
        label={`${platform.name} leased`}
        {...(percent === undefined ? {} : { percent })}
      />
      <div>
        <div className="overview-ring-name">{platform.name}</div>
        <div className="overview-meta">
          {platform.leased} of {platform.total} leased
          {platform.notRead === 0 ? "" : ` · ${platform.notRead} not read yet`}
        </div>
      </div>
    </div>
  );
}

function QueueList({ queue }: { readonly queue: QueueCard | Unavailable }) {
  if ("unavailable" in queue) return <p className="empty">Unavailable: {queue.unavailable}</p>;
  if (queue.rows.length === 0) return <p className="empty">Nothing is waiting.</p>;
  return (
    <ul className="overview-list">
      {queue.rows.map((row) => (
        <li key={row.key}>
          <Link to={row.to} className="overview-item">
            <span className="overview-place">{row.place}</span>
            <AgentChip kind={row.kind} title={row.holderTitle} />
            <span className="overview-holder" title={row.holderTitle}>
              {row.holder}
            </span>
            <span className="overview-time">{row.waited}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function EndingList({ ending }: { readonly ending: EndingCard | Unavailable }) {
  if ("unavailable" in ending) return <p className="empty">Unavailable: {ending.unavailable}</p>;
  if (ending.rows.length === 0) return <p className="empty">No lease ends soon.</p>;
  return (
    <ul className="overview-list">
      {ending.rows.map((row) => (
        <li key={row.key}>
          <Link to={row.to} className="overview-item">
            <AgentChip kind={row.kind} title={row.holderTitle} />
            <span className="overview-stack">
              <span className="overview-holder" title={row.holderTitle}>
                {row.holder}
              </span>
              <span className="overview-clip" title={row.sub}>
                {row.sub}
              </span>
            </span>
            <span className="overview-ttl">
              <b>{row.remaining}</b>
              <Meter percent={row.percent} tone="warn" size="thin" />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
