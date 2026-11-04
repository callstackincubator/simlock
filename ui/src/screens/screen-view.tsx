import "./screen-view.css";

import { useId } from "react";

import { Facts, InfoPopover, Refusal, Status } from "../ds";
import type { Screen } from "../state/screen";

export function ScreenView(props: { readonly screen: Screen }) {
  const { screen } = props;
  const { live, note, readout, waiting } = screen;
  const title = useId();
  return (
    <section className="screen-panel" aria-labelledby={title}>
      <header className="screen-head">
        <h3 id={title} className="lease-card-title">
          Screen
        </h3>
        <InfoPopover label="Stream details">
          <Facts
            facts={[
              {
                label: "State",
                value: <Status tone={readout.state.tone}>{readout.state.word}</Status>,
              },
              ...readout.facts.map((fact) => ({
                label: fact.label,
                value: <span className="mono">{fact.value}</span>,
              })),
            ]}
          />
        </InfoPopover>
      </header>
      <div className="phone">
        {live ? (
          <canvas
            aria-label="The device's screen"
            className="phone-canvas"
            height={screen.height}
            ref={screen.canvas}
            width={screen.width}
          />
        ) : (
          <p className="phone-off">No picture while this is off.</p>
        )}
        {waiting === undefined ? null : <p className="phone-wait">{waiting}</p>}
      </div>
      {note === undefined ? null : <Refusal message={note} />}
    </section>
  );
}
