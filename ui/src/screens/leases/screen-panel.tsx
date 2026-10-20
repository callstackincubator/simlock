import { useId } from "react";

import { Button, Facts, Refusal, Status } from "../../ds";
import { type Screen, useScreen } from "../../state/screen";

// why: the hook lives in the panel's own component so that closing the page, leaving the lease and
// pressing Stop all end the same capture, and a panel that is not drawn never starts one.
export function ScreenPanel(props: {
  readonly leaseId: string;
  readonly offered: boolean;
  readonly reason: string | undefined;
}) {
  const screen = useScreen(props.leaseId);
  return <ScreenView screen={screen} offered={props.offered} reason={props.reason} />;
}

export function ScreenView(props: {
  readonly screen: Screen;
  readonly offered: boolean;
  readonly reason: string | undefined;
}) {
  const { offered, reason, screen } = props;
  const { live, note, readout, waiting } = screen;
  const title = useId();
  const why = useId();
  return (
    <section className="screen-panel" aria-labelledby={title}>
      <header className="screen-head">
        <h3 id={title} className="lease-card-title">
          Screen
        </h3>
        <Button
          disabled={!offered}
          aria-describedby={offered ? undefined : why}
          onClick={live ? screen.stop : screen.start}
        >
          {live ? "Stop" : "Show screen"}
        </Button>
      </header>
      {offered || reason === undefined ? null : (
        <p id={why} className="muted screen-reason">
          {reason}
        </p>
      )}
      <div className="phone">
        {live ? (
          <canvas
            aria-label="The leased device's screen"
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
      {note === undefined ? null : <Refusal message={note} />}
    </section>
  );
}
