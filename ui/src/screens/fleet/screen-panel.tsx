import "./screen-panel.css";

import type { CSSProperties } from "react";

import { type StreamOffer, useDeviceScreen } from "../../state/screen";

// why: the hook lives in the panel's own component so that leaving the page ends the capture, and a
// panel that is not drawn never starts one. The picture sits in a phone-shaped frame with two pills
// over it that say what the stream is doing, from the decoder's own figures.
export function ScreenPanel(props: {
  readonly workerId: string;
  readonly deviceId: string;
  readonly state: string;
  readonly offer: StreamOffer;
}) {
  const { deviceId, offer, state, workerId } = props;
  const shown = useDeviceScreen(workerId, deviceId, state, offer);
  if (shown.kind !== "picture") {
    return (
      <div className="screen-panel">
        <div className="phone">
          <p className="phone-off">{shown.text}</p>
        </div>
      </div>
    );
  }
  const { screen } = shown;
  const { live, note, readout, waiting } = screen;
  const landscape = screen.width > screen.height && screen.height > 0;
  return (
    <div className="screen-panel">
      {readout.overlay === undefined ? null : (
        <div className="screen-pills">
          <span className="screen-pill">
            <i aria-hidden="true" />
            LIVE · {readout.overlay.rate}
          </span>
          <span className="screen-pill">{readout.overlay.summary}</span>
        </div>
      )}
      <div
        className={landscape ? "phone phone-landscape" : "phone"}
        style={
          screen.height > 0
            ? ({ "--picture-ratio": `${screen.width} / ${screen.height}` } as CSSProperties)
            : undefined
        }
      >
        {live ? (
          <canvas
            aria-label="The device's screen"
            className="phone-canvas"
            height={screen.height}
            ref={screen.canvas}
            width={screen.width}
          />
        ) : (
          <p className="phone-off">{note ?? "No picture while this is off."}</p>
        )}
        {waiting === undefined ? null : <p className="phone-wait">{waiting}</p>}
      </div>
    </div>
  );
}
