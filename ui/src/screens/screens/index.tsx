import "./screens.css";

import {
  Button,
  ChoiceChips,
  type Column,
  DataTable,
  Link,
  Loaded,
  Page,
  Panel,
  Pill,
} from "../../ds";
import {
  type AcquireCapture,
  SCREEN_FILTERS,
  type ScreenTile,
  useScreens,
  useScreenTile,
  WATCH_LIMIT,
} from "../../state/screens";
import { useDeviceScreen } from "../../state/screen";
import { ScreenNotice, ScreenView } from "../screen-view";

type Screens = ReturnType<typeof useScreens>;

export function ScreensScreen() {
  const screens = useScreens();
  const { choose, filter, view } = screens;
  return (
    <Page title="Screens">
      <Loaded view={view}>
        {(page) => (
          <div className="screens-page">
            <Panel
              title="Watching"
              lead={
                <span className="mono muted">
                  {page.watched.length} of {WATCH_LIMIT}
                </span>
              }
            >
              {page.watched.length === 0 ? (
                <p className="screens-none">
                  Choose <b>Watch</b> on a running device below to see its screen here. Up to{" "}
                  {WATCH_LIMIT} screens stream at once.
                </p>
              ) : (
                <div className="screens-watching">
                  {page.watched.map((tile) => (
                    <Watched key={tile.key} tile={tile} screens={screens} />
                  ))}
                  {Array.from({ length: WATCH_LIMIT - page.watched.length }, (_, index) => (
                    <div key={index} className="screens-slot-empty" aria-hidden="true" />
                  ))}
                </div>
              )}
            </Panel>
            <Panel
              title="Running devices"
              lead={
                <span className="mono muted">
                  {page.counts.leased} leased · {page.counts.ready} ready
                </span>
              }
              flush
            >
              <div className="screens-filters">
                <ChoiceChips
                  legend="Show devices"
                  choices={SCREEN_FILTERS}
                  value={filter}
                  onChange={choose}
                />
              </div>
              <DataTable
                label="Running devices"
                rows={page.rows}
                columns={columns(screens)}
                rowId={(tile) => tile.key}
                rowClassName={(tile) =>
                  screens.isWatched(tile) ? "screens-row-watched" : undefined
                }
                empty={filter === "all" ? "No running devices." : `No ${filter} devices.`}
                paging={page.paging}
              />
            </Panel>
          </div>
        )}
      </Loaded>
    </Page>
  );
}

function columns(screens: Screens): readonly Column<ScreenTile>[] {
  return [
    {
      cell: (tile) =>
        tile.holder === undefined ? (
          <span className="muted">Not leased</span>
        ) : (
          <span className="screens-cut" title={tile.holder.full}>
            {tile.holder.short}
          </span>
        ),
      header: "Holder",
    },
    {
      cell: (tile) => (
        <span className="screens-cut" title={`${tile.label} · ${tile.platform} ${tile.runtime}`}>
          {tile.label} · {tile.platform} {tile.runtime}
        </span>
      ),
      fit: 220,
      header: "Device",
      mono: true,
    },
    {
      cell: (tile) => (
        <span className="screens-cut" title={tile.worker}>
          {tile.worker}
        </span>
      ),
      drop: 2,
      fit: 160,
      header: "Worker",
      mono: true,
    },
    {
      cell: (tile) => <Pill tone={tile.state.tone}>{tile.state.word}</Pill>,
      drop: 3,
      fit: 100,
      header: "State",
    },
    {
      cell: (tile) => tile.leasedFor ?? "—",
      drop: 1,
      fit: 110,
      header: "Leased for",
      mono: true,
    },
    {
      cell: (tile) => <WatchButton tile={tile} screens={screens} />,
      fit: 130,
      header: "Watch",
      hideHeader: true,
    },
  ];
}

function WatchButton({ tile, screens }: { readonly tile: ScreenTile; readonly screens: Screens }) {
  const name = `${tile.holder?.full ?? tile.label}, ${tile.label} on ${tile.worker} (${tile.deviceId})`;
  if (screens.isWatched(tile))
    return (
      <Button small aria-label={`Stop watching ${name}`} onClick={() => screens.stop(tile)}>
        Stop
      </Button>
    );
  return (
    <Button
      small
      variant="primary"
      aria-label={`Watch ${name}`}
      disabled={screens.full}
      title={screens.full ? `${WATCH_LIMIT} screens are already being watched.` : undefined}
      onClick={() => screens.watch(tile)}
    >
      Watch
    </Button>
  );
}

function Watched({ tile, screens }: { readonly tile: ScreenTile; readonly screens: Screens }) {
  const { notice } = useScreenTile(tile, screens.connected);
  const name = `${tile.holder?.full ?? tile.label}, ${tile.label} on ${tile.worker} (${tile.deviceId})`;
  return (
    <article className="screens-slot" aria-label={`Screen: ${name}`}>
      {notice !== undefined ? (
        <ScreenNotice text={notice} />
      ) : (
        <Picture tile={tile} acquire={screens.acquire} />
      )}
      <div className="screens-caption">
        <b className="screens-cut" title={tile.holder?.full ?? "Not leased"}>
          {tile.holder?.short ?? "Not leased"}
        </b>
        <span className="screens-cut mono muted" title={`${tile.label} · ${tile.worker}`}>
          {tile.label} · {tile.platform} {tile.runtime} · {tile.worker}
        </span>
        <span className="screens-actions">
          <Button small aria-label={`Stop watching ${name}`} onClick={() => screens.stop(tile)}>
            Stop watching
          </Button>
          <Link to={tile.to} aria-label={`Open streaming page: ${name}`}>
            Open
          </Link>
        </span>
      </div>
    </article>
  );
}

function Picture({
  tile,
  acquire,
}: {
  readonly tile: ScreenTile;
  readonly acquire: AcquireCapture;
}) {
  const shown = useDeviceScreen(tile.workerId, tile.deviceId, tile.state.word, tile.offer, acquire);
  return shown.kind === "picture" ? (
    <ScreenView screen={shown.screen} />
  ) : (
    <ScreenNotice text={shown.text} />
  );
}
