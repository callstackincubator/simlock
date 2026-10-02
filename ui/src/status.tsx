import type { ReactNode } from "react";

/**
 * A status is always a word with its colour (docs/internal/DESIGN.md): the colour is a second
 * signal, never the only one, and never the accent. The word is the daemon's own, so the
 * console and the CLI agree.
 */
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
  shutdown: "idle",
  deleted: "idle",
};

const CONNECTIONS: Tones = { connected: "ok", disconnected: "error", incompatible: "error" };

const HEALTH: Tones = { running: "ok", starting: "warn", failed: "error" };

const INSTALL_STATES: Tones = { downloading: "ok", waiting: "idle" };

/**
 * Each status the daemon sends, as a word and a tone. Wire input is a claim: a word this
 * console does not know, from a newer daemon, still shows as itself, in the neutral tone.
 */
function statusOf(tones: Tones, word: string): { readonly word: string; readonly tone: Tone } {
  return { tone: tones[word] ?? "idle", word };
}

export const deviceStateStatus = (state: string) => statusOf(DEVICE_STATES, state);
export const connectionStatus = (connection: string) => statusOf(CONNECTIONS, connection);
export const healthStatus = (health: string) => statusOf(HEALTH, health);
export const installStatus = (state: string) => statusOf(INSTALL_STATES, state);
