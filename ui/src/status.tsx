import type { ReactNode } from "react";

/** why: the colour is a second signal, never the only one, and never the accent. */
export type Tone = "ok" | "warn" | "error" | "idle";

export function Status({ tone, children }: { readonly tone: Tone; readonly children: ReactNode }) {
  return (
    <span className={`status status-${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

type Tones = Readonly<Partial<Record<string, Tone>>>;

const DEVICE_STATES: Tones = {
  ready: "ok",
  leased: "ok",
  provisioning: "idle",
  reclaiming: "idle",
  quarantined: "error",
  absent: "warn",
  shutdown: "idle",
  deleted: "idle",
};

const CONNECTIONS: Tones = { connected: "ok", disconnected: "error", incompatible: "error" };

const HEALTH: Tones = { running: "ok", starting: "warn", failed: "error" };

const PRESSURE: Tones = { normal: "ok", warn: "warn", critical: "error" };

const INSTALL_STATES: Tones = { downloading: "ok", waiting: "idle" };

const WAITING_STAGES: Tones = { queued: "idle", starting: "ok" };

/**
 * why: wire input is a claim: a word from a newer daemon this console does not know still shows as
 * itself, in the neutral tone.
 */
function statusOf(tones: Tones, word: string): { readonly word: string; readonly tone: Tone } {
  return { tone: tones[word] ?? "idle", word };
}

export const deviceStateStatus = (state: string) => statusOf(DEVICE_STATES, state);
export const connectionStatus = (connection: string) => statusOf(CONNECTIONS, connection);
export const healthStatus = (health: string) => statusOf(HEALTH, health);
export const installStatus = (state: string) => statusOf(INSTALL_STATES, state);
export const waitingStageStatus = (stage: string) => statusOf(WAITING_STAGES, stage);
export const pressureStatus = (pressure: string) => statusOf(PRESSURE, pressure);
