import { Status, type Tone } from "../status";
import type { ConnectionPhase, ConnectionState } from "./connection";
import { useConnection, useNow } from "./live-context";
import { formatDuration } from "./time";

/**
 * What the console says about its connection (ADR 0013 §5). The phase is a live region; the
 * data's age beside it ticks every second, so it is left out of the region to keep a screen
 * reader from announcing every tick.
 */
export function ConnectionBanner() {
  const state = useConnection();
  const now = useNow();
  const { age, phase, tone } = describe(state, now.browser);
  return (
    <div className="connection">
      <Status tone={tone}>
        <span role="status">{phase}</span>
        {age === undefined ? null : <span> — data from {age} ago</span>}
      </Status>
    </div>
  );
}

const PHASES: Readonly<Record<ConnectionPhase, { readonly phase: string; readonly tone: Tone }>> = {
  connected: { phase: "Connected", tone: "ok" },
  disconnected: { phase: "Reconnecting", tone: "error" },
  starting: { phase: "Daemon is starting", tone: "warn" },
};

/** The data's age shows only while reconnecting: starting, the daemon is about to answer. */
function describe(
  state: ConnectionState,
  browserNow: number,
): { readonly phase: string; readonly tone: Tone; readonly age?: string } {
  const shown = PHASES[state.phase];
  if (state.phase !== "disconnected" || state.answeredAt === undefined) return shown;
  return { ...shown, age: formatDuration(browserNow - state.answeredAt) };
}
