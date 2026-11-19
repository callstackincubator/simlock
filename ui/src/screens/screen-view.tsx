import "./screen-view.css";

import type { CSSProperties } from "react";

import type { Screen } from "../state/screen";

// why: the Fleet drawer and the Screens grid draw the same stream the same way. The picture sits in
// a phone-shaped frame with two pills over it that say what the stream is doing, from the decoder's
// own figures.
export function ScreenView(props: { readonly screen: Screen; readonly label?: string }) {
  const { screen, label } = props;
  const { live, note, readout, waiting } = screen;
  const landscape = screen.width > screen.height && screen.height > 0;
  return (
    <section className="screen-panel" aria-label={label}>
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
    </section>
  );
}

// why: a stream that cannot start yet says so inside the same frame, so the frame never moves.
export function ScreenNotice(props: { readonly text: string }) {
  return (
    <div className="screen-panel">
      <div className="phone">
        <p className="phone-off">{props.text}</p>
      </div>
    </div>
  );
}
