import "./overview.css";

import {
  ChartPanel,
  ChoiceChips,
  Link,
  Loaded,
  Page,
  Panel,
  Refusal,
  Row,
  ShareBar,
  StatRow,
  StatTile,
  Status,
  Toolbar,
} from "../../ds";
import { WorkersTable } from "../fleet";
import type { FiguresState } from "../../state/figures";
import { type ConsoleRange, RANGE_CHOICES, useRange } from "../../state/range";
import {
  type Overview,
  type OverviewInbox,
  type PlatformCapacity,
  useOverview,
} from "../../state/overview";

export function OverviewScreen() {
  const [range, setRange] = useRange();
  const view = useOverview(range);
  return (
    <Page title="Overview">
      <Loaded view={view}>
        {(overview) => <OverviewBody overview={overview} range={range} onRange={setRange} />}
      </Loaded>
    </Page>
  );
}

function FigureNote({ figures }: { readonly figures: FiguresState }) {
  if (figures.kind === "loading") return <p className="muted loaded-note">Loading…</p>;
  if (figures.kind === "refused") return <Refusal message={figures.message} />;
  return null;
}

export function OverviewBody(props: {
  readonly overview: Overview;
  readonly range?: ConsoleRange;
  readonly onRange?: (range: ConsoleRange) => void;
}) {
  const { overview, range = "1h", onRange = () => undefined } = props;
  const { figures } = overview;
  const ready = figures.kind === "ready" ? figures : undefined;
  // why: Device slots in use is drawn on Usage; the Overview keeps the two charts of load.
  const [leases, ...others] = (ready?.data.charts ?? []).filter(
    (chart) => chart.key !== "slotsUsed",
  );
  return (
    <>
      <Toolbar
        start={
          <ChoiceChips legend="Range" choices={RANGE_CHOICES} value={range} onChange={onRange} />
        }
        end={ready?.data.note === undefined ? null : <p className="muted">{ready.data.note}</p>}
      />
      {ready?.refusal === undefined ? null : <Refusal message={ready.refusal} />}
      <StatRow label="Fleet at a glance">
        {overview.tiles.map((tile) => (
          <StatTile key={tile.label} {...tile} />
        ))}
        {overview.wait === undefined ? (
          <li className="stat">
            <div className="stat-body">
              <FigureNote figures={figures} />
            </div>
          </li>
        ) : (
          <StatTile {...overview.wait} />
        )}
        <StatTile {...overview.ending} />
      </StatRow>
      <Row>
        <NeedsYou inbox={overview.inbox} />
        <Panel title="Capacity · all workers">
          <div className="capacity">
            {overview.capacity.map((platform) => (
              <PlatformBar key={platform.name} platform={platform} />
            ))}
          </div>
        </Panel>
      </Row>
      <Row even>
        {leases === undefined ? (
          <Panel title="Figures">
            <FigureNote figures={figures} />
          </Panel>
        ) : (
          <ChartPanel chart={leases} />
        )}
        {others.map((chart) => (
          <ChartPanel key={chart.key} chart={chart} />
        ))}
      </Row>
      <Panel title="Workers" flush actions={<Link to="/fleet">Open Fleet</Link>}>
        <WorkersTable rows={overview.workers} empty="No workers have connected." />
      </Panel>
    </>
  );
}

function PlatformBar({ platform }: { readonly platform: PlatformCapacity }) {
  const words = platform.parts.map((part) => `${part.count} ${part.word}`).join(", ");
  const notRead =
    platform.notRead === 0
      ? null
      : platform.notRead === 1
        ? "1 worker not read yet"
        : `${platform.notRead} workers not read yet`;
  return (
    <div className="platform">
      <p className="platform-head">
        <span>{platform.name}</span>
        {notRead === null ? null : <span className="muted">{notRead}</span>}
      </p>
      <span role="img" aria-label={`${platform.name}: ${words === "" ? "no devices" : words}`}>
        <ShareBar shares={platform.parts} />
      </span>
      <ul className="platform-parts">
        {platform.parts.map((part) => (
          <li key={part.kind}>
            <span className={`slot slot-${part.kind}`} aria-hidden="true" />
            <span className="mono">{part.count}</span> {part.word}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NeedsYou({ inbox }: { readonly inbox: OverviewInbox }) {
  if (inbox.problems === 0) {
    return (
      <Panel title="Needs you">
        <p className="muted needs-you-none">Nothing needs you</p>
      </Panel>
    );
  }
  return (
    <div className="overview-side">
      <Panel title="Needs you" flush>
        <ul className="overview-list">
          {inbox.needsYou.map((item) => (
            <li key={item.key}>
              <Link to={item.to} className="overview-row">
                <Status tone={item.tone}>{item.word}</Status>
                <span className="overview-row-aside">{item.subject}</span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="overview-all">
          <Link to="/inbox">{`All in Inbox (${inbox.problems})`}</Link>
        </p>
      </Panel>
    </div>
  );
}
