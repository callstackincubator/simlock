import "./screens.css";

import { Empty, Id, Link, Loaded, Page } from "../../ds";
import {
  type AcquireCapture,
  type ScreenTile,
  useScreens,
  useScreenTile,
} from "../../state/screens";
import { useDeviceScreen } from "../../state/screen";
import { ScreenView } from "../screen-view";

export function ScreensScreen() {
  const { view, connected, acquire } = useScreens();
  return (
    <Page title="Screens">
      <Loaded view={view}>
        {(tiles) =>
          tiles.length === 0 ? (
            <Empty>No running devices.</Empty>
          ) : (
            <div className="screens-grid">
              {tiles.map((tile) => (
                <Tile key={tile.key} tile={tile} connected={connected} acquire={acquire} />
              ))}
            </div>
          )
        }
      </Loaded>
    </Page>
  );
}

function Tile({
  tile,
  connected,
  acquire,
}: {
  readonly tile: ScreenTile;
  readonly connected: boolean;
  readonly acquire: AcquireCapture;
}) {
  const { target, notice } = useScreenTile(tile, connected);
  return (
    <article
      className="screens-tile"
      ref={target}
      aria-label={`${tile.worker}: ${tile.label} (${tile.deviceId})`}
    >
      <header className="screens-tile-head">
        <h2>{tile.label}</h2>
        <p className="muted">{tile.worker}</p>
        <p>
          <Id>{tile.deviceId}</Id>
        </p>
        <p className="mono muted">
          {tile.platform} {tile.runtime} · {tile.state}
        </p>
        <Link
          to={tile.to}
          aria-label={`Open device Screen: ${tile.worker} (${tile.workerId}), ${tile.label} (${tile.deviceId})`}
        >
          Open device Screen
        </Link>
      </header>
      {notice !== undefined ? (
        <ScreenNotice text={notice} />
      ) : (
        <Picture tile={tile} acquire={acquire} />
      )}
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
  const shown = useDeviceScreen(tile.workerId, tile.deviceId, tile.state, tile.offer, acquire);
  return shown.kind === "picture" ? (
    <ScreenView
      screen={shown.screen}
      label={`Screen: ${tile.worker} (${tile.workerId}), ${tile.label} (${tile.deviceId})`}
    />
  ) : (
    <ScreenNotice text={shown.text} />
  );
}

function ScreenNotice({ text }: { readonly text: string }) {
  return (
    <div className="screen-panel screens-placeholder">
      <div className="screen-head">
        <h3 className="lease-card-title">Screen</h3>
      </div>
      <div className="phone">
        <p className="phone-off">{text}</p>
      </div>
    </div>
  );
}
