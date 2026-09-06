/**
 * The worker's half of the uplink (ADR 0005 §4): one outbound connection to `gateway.url`,
 * redialled with capped, jittered exponential backoff after any disconnect, and handed to this
 * daemon's own `DaemonServer` as one more connection to serve.
 *
 * It is a supervisor, not a protocol: everything about what travels over the link lives in
 * `DaemonServer` (which serves it) and in the gateway (which drives it). All this class decides
 * is *when to dial*.
 */
import type { Clock, IpcConnection, Logger, TimerHandle, UplinkConnector } from "../ports/index.js";
import { NoopLogger, UplinkError } from "../ports/index.js";

export interface UplinkBackoff {
  /** Delay before the first retry. */
  readonly initialMs: number;
  /** Ceiling the delay grows to and stays at (ADR 0005 §4/§8: a worker whose token was revoked
   * keeps retrying *at the cap* -- an operator may mint a new token at any time, and a worker
   * that gave up would then need a restart nobody would think to perform). */
  readonly maxMs: number;
  readonly multiplier: number;
}

export const DEFAULT_UPLINK_BACKOFF: UplinkBackoff = {
  initialMs: 1_000,
  maxMs: 30_000,
  multiplier: 2,
};

export interface GatewayUplinkOptions {
  readonly clock: Clock;
  readonly connector: UplinkConnector;
  /** `gateway.url`. */
  readonly url: string;
  /** `gateway.token`, the join token this worker presents. */
  readonly token: string;
  /** `gateway.label`, display-only (ADR 0005 §3a). */
  readonly label?: string;
  /** This worker's instance id (`instance.json`) -- its fleet identity (§3a). */
  readonly workerId: string;
  /** Hands an established uplink to whoever serves it (`DaemonServer#acceptUplink`). */
  readonly accept: (connection: IpcConnection) => void;
  readonly logger?: Logger;
  readonly backoff?: UplinkBackoff;
  /**
   * Jitter source, injected so a test gets a deterministic schedule. Defaults to `Math.random`.
   * Jitter matters here for the same reason it does in any reconnect loop: a gateway restart
   * disconnects every worker at once, and an unjittered fleet would redial in lockstep forever.
   */
  readonly random?: () => number;
}

export class GatewayUplink {
  readonly #logger: Logger;
  readonly #backoff: UplinkBackoff;
  readonly #random: () => number;
  #attempt = 0;
  #timer: TimerHandle | undefined;
  #connection: IpcConnection | undefined;
  #stopped = false;
  /** Guards against two dials in flight at once -- a `close` arriving while a dial is pending
   * would otherwise schedule a second one beside it. */
  #dialing = false;

  constructor(private readonly options: GatewayUplinkOptions) {
    this.#logger = options.logger ?? new NoopLogger();
    this.#backoff = options.backoff ?? DEFAULT_UPLINK_BACKOFF;
    this.#random = options.random ?? Math.random;
  }

  /**
   * Dials now, and keeps redialling for the daemon's lifetime. Deliberately synchronous and
   * fire-and-forget: a worker whose gateway is down must still come up and serve its local
   * agents, so nothing in the daemon's startup path ever waits on this.
   */
  start(): void {
    if (this.#stopped) return;
    void this.#dial();
  }

  /** Stops redialling and closes the current uplink, if any. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== undefined) {
      this.options.clock.cancel(this.#timer);
      this.#timer = undefined;
    }
    const connection = this.#connection;
    this.#connection = undefined;
    await connection?.close();
  }

  async #dial(): Promise<void> {
    if (this.#stopped || this.#dialing || this.#connection !== undefined) return;
    this.#dialing = true;
    this.#attempt += 1;
    try {
      const connection = await this.options.connector.connect({
        url: this.options.url,
        token: this.options.token,
        workerId: this.options.workerId,
        ...(this.options.label === undefined ? {} : { label: this.options.label }),
      });
      if (this.#stopped) {
        // A stop that landed while the dial was in flight: close what we just opened rather
        // than handing a connection to a daemon that is shutting down.
        await connection.close();
        return;
      }
      this.#attempt = 0;
      this.#connection = connection;
      connection.onClose(() => this.#onClosed());
      this.#logger.info("Uplink to gateway established", {
        url: this.options.url,
        workerId: this.options.workerId,
      });
      this.options.accept(connection);
    } catch (error: unknown) {
      const delayMs = this.#nextDelayMs();
      // `warn`, not `error`: a gateway that is down is an expected state for a worker, which
      // goes on serving its local agents throughout. The `reason` is what tells an operator a
      // revoked token apart from an unreachable gateway -- both retry, only one is fixable by
      // waiting.
      this.#logger.warn("Uplink to gateway failed; retrying", {
        url: this.options.url,
        reason: error instanceof UplinkError ? error.code : "unknown",
        message: error instanceof Error ? error.message : String(error),
        retryInMs: delayMs,
      });
      this.#scheduleRetry(delayMs);
    } finally {
      this.#dialing = false;
    }
  }

  #onClosed(): void {
    this.#connection = undefined;
    if (this.#stopped) return;
    const delayMs = this.#nextDelayMs();
    this.#logger.info("Uplink to gateway closed; reconnecting", {
      url: this.options.url,
      retryInMs: delayMs,
    });
    this.#scheduleRetry(delayMs);
  }

  #scheduleRetry(delayMs: number): void {
    if (this.#stopped || this.#timer !== undefined) return;
    this.#timer = this.options.clock.setTimer(delayMs, () => {
      this.#timer = undefined;
      void this.#dial();
    });
  }

  /**
   * Exponential up to the cap, then jittered across the lower half of the resulting window
   * (`[delay/2, delay]`). Half-window rather than full: a fleet redialling after a gateway
   * restart must spread out, but a worker should not idle for a full cap's worth of seconds
   * when the gateway is already back.
   */
  #nextDelayMs(): number {
    const exponential =
      this.#backoff.initialMs * this.#backoff.multiplier ** Math.max(0, this.#attempt - 1);
    const capped = Math.min(this.#backoff.maxMs, exponential);
    return Math.round(capped * (0.5 + this.#random() * 0.5));
  }
}
