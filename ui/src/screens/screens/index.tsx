import "./screens.css";

import { Empty, Id, Link, Loaded, Page } from "../../ds";
import { type ScreenTile, useScreens, useScreenVisibility } from "../../state/screens";
import { useDeviceScreen } from "../../state/screen";
import { ScreenView } from "../screen-view";

export function ScreensScreen() {
  const { view, connected } = useScreens();
  return (
    <Page title="Screens">
      <Loaded view={view}>
        {(tiles) =>
          tiles.length === 0 ? (
            <Empty>No running devices.</Empty>
          ) : (
            <div className="screens-grid">
              {tiles.map((tile) => (
                <Tile key={tile.key} tile={tile} connected={connected} />
              ))}
            </div>
          )
        }
      </Loaded>
    </Page>
  );
}

function Tile({ tile, connected }: { readonly tile: ScreenTile; readonly connected: boolean }) {
  const { target, active } = useScreenVisibility();
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
        <Link to={tile.to}>Open device Screen</Link>
      </header>
      {!connected ? (
        <ScreenNotice text="Disconnected from the daemon." />
      ) : !tile.offer.offered ? (
        <ScreenNotice text={tile.offer.reason ?? "Streaming is unavailable."} />
      ) : active ? (
        <Picture tile={tile} />
      ) : (
        <ScreenNotice text="Paused while out of view." />
      )}
    </article>
  );
}

function Picture({ tile }: { readonly tile: ScreenTile }) {
  const shown = useDeviceScreen(tile.workerId, tile.deviceId, tile.state, tile.offer);
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
