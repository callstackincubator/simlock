import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  TUNNEL_HELLO_MAX_BYTES,
  TUNNEL_MAX_DATA_BYTES,
  TUNNEL_MAX_DEVICE_PORT,
  TUNNEL_MAX_TUNNELS,
  TUNNEL_MIN_DEVICE_PORT,
  TUNNEL_REFUSED_CLOSE,
  TUNNEL_TAG,
  TUNNEL_WINDOW_BYTES,
  TUNNEL_WINDOW_LIMIT,
  type TunnelFrame,
} from "../contract/index.js";
import {
  DeviceTcpError,
  stableError,
  toDriverDevice,
  unsupportedTunnelMessage,
  type DeviceRecord,
  type DeviceReverse,
} from "../core/index.js";
import type { ModuleDeviceTcp } from "../modules/index.js";
import type { Clock, LeaseSocket, Logger, TcpStream, TimerHandle } from "../ports/index.js";

const CLOSE_LEASE_ENDED = 4001;
const CLOSE_GOING_AWAY = 1001;
const MAX_CONNECTIONS = 256;
// why: a WebSocket close reason is at most 123 bytes, and `ws` throws on a longer one, so a long message is cut for the close and sent whole in REFUSED.
const CLOSE_REASON_MAX_BYTES = 123;
const REMOVAL_TIMEOUT_MS = 10_000;
const CREDIT_BYTES = 4;

interface Tunnel {
  readonly kind: "reverse" | "forward";
  readonly devicePort: number;
}

interface Connection {
  readonly stream: TcpStream;
  // why: how many bytes the worker may still send before the caller grants more credit.
  window: number;
  // why: how many bytes the caller may still send before the worker grants more credit.
  inbound: number;
  closed: boolean;
  // why: a connection is done only when both directions have said END, so each side's END is remembered.
  deviceEnded: boolean;
  callerEnded: boolean;
  wake: (() => void) | undefined;
}

interface Refusal {
  readonly code: string;
  readonly message: string;
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

// why: the HELLO is wire input from a holder, so its size and shape are checked before any of it is used; a string is what was wrong with it.
// fallow-ignore-next-line complexity -- one validator: each branch is one refusal the spec words.
function parseHello(payload: Uint8Array): readonly Tunnel[] | string {
  if (payload.length > TUNNEL_HELLO_MAX_BYTES) {
    return `HELLO is longer than ${String(TUNNEL_HELLO_MAX_BYTES)} bytes`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return "HELLO is not valid JSON";
  }
  const named = field(parsed, "tunnels");
  if (!Array.isArray(named) || named.length === 0) return "HELLO must name 1 to 8 tunnels";
  const tunnels: Tunnel[] = [];
  for (const entry of named) {
    const kind = field(entry, "kind");
    const devicePort = field(entry, "devicePort");
    if (
      (kind !== "reverse" && kind !== "forward") ||
      typeof devicePort !== "number" ||
      !Number.isInteger(devicePort)
    ) {
      return "HELLO tunnels must each be {kind, devicePort}";
    }
    tunnels.push({ devicePort, kind });
  }
  return tunnels;
}

function closeReason(message: string): string {
  const bytes = new TextEncoder().encode(message);
  if (bytes.length <= CLOSE_REASON_MAX_BYTES) return message;
  return new TextDecoder().decode(bytes.subarray(0, CLOSE_REASON_MAX_BYTES)).replace(/�+$/u, "");
}

function refusal(tunnels: readonly Tunnel[], held: number): Refusal | undefined {
  if (held + tunnels.length > TUNNEL_MAX_TUNNELS) {
    return {
      code: "TUNNEL_LIMIT",
      message: `the lease already has ${String(held)} tunnels; at most ${String(TUNNEL_MAX_TUNNELS)}`,
    };
  }
  for (const { devicePort, kind } of tunnels) {
    if (devicePort < TUNNEL_MIN_DEVICE_PORT || devicePort > TUNNEL_MAX_DEVICE_PORT) {
      return {
        code: "TUNNEL_BAD_PORT",
        message: `${kind} ${String(devicePort)}: device ports are ${String(TUNNEL_MIN_DEVICE_PORT)} to ${String(TUNNEL_MAX_DEVICE_PORT)}`,
      };
    }
  }
  if (tunnels.some(({ kind }) => kind === "forward")) {
    return { code: "TUNNEL_UNSUPPORTED", message: "forward tunnels are not available yet" };
  }
  return undefined;
}

// why: one socket's state that the lease's end and the daemon's stop reach from outside: `finish` closes its connections and, unless the reclaim that follows does it, removes its rules.
interface Session {
  readonly socket: LeaseSocket;
  finish(removeRules: boolean, signal?: AbortSignal): Promise<void>;
}

export interface TunnelSessions {
  attach(leaseId: string, device: DeviceRecord, socket: LeaseSocket): void;
  end(leaseId: string, reason: string, signal: AbortSignal): Promise<void>;
  drain(): Promise<void>;
}

export function createTunnelSessions(options: {
  readonly deviceTcp: ModuleDeviceTcp;
  readonly logger: Logger;
  readonly clock: Clock;
}): TunnelSessions {
  // why: the 8-tunnel limit counts every socket of one lease, so the count is the lease's, not the socket's.
  const counts = new Map<string, number>();
  const sessions = new Map<string, Set<Session>>();

  function attach(leaseId: string, device: DeviceRecord, socket: LeaseSocket): void {
    let nextConnection = 1;
    let greeted = false;
    let reserved = 0;
    let finished: Promise<void> | undefined;
    // why: a rule that arrives after `finish` read the list is removed only if the end that finished the session removed its own.
    let endedWith:
      | { readonly remove: boolean; readonly signal: AbortSignal | undefined }
      | undefined;
    const connections = new Map<number, Connection>();
    const reverses: DeviceReverse[] = [];

    function finish(removeRules: boolean, signal?: AbortSignal): Promise<void> {
      finished ??= (async () => {
        endedWith = { remove: removeRules, signal };
        sessions.get(leaseId)?.delete(session);
        counts.set(leaseId, (counts.get(leaseId) ?? 0) - reserved);
        for (const connection of connections.values()) {
          connection.closed = true;
          connection.stream.close();
          connection.wake?.();
        }
        connections.clear();
        if (!removeRules) return;
        // why: one after another, so a lease-end signal that aborts mid-way stops the removals that reclaim is about to do.
        for (const reverse of reverses) {
          if (signal?.aborted === true) return;
          await bounded(removeRule(reverse));
        }
      })();
      return finished;
    }

    // why: an adb call that never answers must not hold the lease's end or the daemon's stop, so each removal waits at most 10 s.
    async function bounded(work: Promise<void>): Promise<void> {
      let handle: TimerHandle | undefined;
      const timeout = new Promise<void>((resolve) => {
        handle = options.clock.setTimer(REMOVAL_TIMEOUT_MS, () => {
          options.logger.warn("A tunnel's device rule removal timed out", {});
          resolve();
        });
      });
      await Promise.race([work, timeout]);
      if (handle !== undefined) options.clock.cancel(handle);
    }

    function removeRule(reverse: DeviceReverse): Promise<void> {
      return reverse.close().catch((error: unknown) => {
        options.logger.warn("A tunnel's device rule could not be removed", {
          error: stableError(error),
        });
      });
    }

    const session: Session = { finish, socket };
    const mine = sessions.get(leaseId) ?? new Set<Session>();
    mine.add(session);
    sessions.set(leaseId, mine);
    socket.onClose(() => void finish(true));

    function settle(conn: number, connection: Connection): void {
      if (!connection.deviceEnded || !connection.callerEnded) return;
      connection.closed = true;
      connection.stream.close();
      connections.delete(conn);
    }

    // why: a connection reads from its device stream only while the caller has granted window, so a slow reader stops its own connection and no other.
    async function pump(conn: number, connection: Connection): Promise<void> {
      const reader = connection.stream.readable.getReader();
      let pending: Uint8Array | undefined;
      for (;;) {
        while (connection.window === 0) {
          await new Promise<void>((wake) => {
            connection.wake = wake;
          });
          if (connection.closed) return;
        }
        if (pending === undefined) {
          const step = await reader.read();
          if (step.done) {
            if (connection.closed) return;
            socket.send(encodeTunnelFrame(TUNNEL_TAG.end, conn));
            connection.deviceEnded = true;
            settle(conn, connection);
            return;
          }
          pending = step.value;
        }
        const size = Math.min(pending.length, connection.window, TUNNEL_MAX_DATA_BYTES);
        socket.send(encodeTunnelFrame(TUNNEL_TAG.data, conn, pending.subarray(0, size)));
        connection.window -= size;
        pending = size === pending.length ? undefined : pending.subarray(size);
      }
    }

    function refuse(refused: Refusal): void {
      socket.send(encodeTunnelFrame(TUNNEL_TAG.refused, 0, JSON.stringify(refused)));
      socket.close(TUNNEL_REFUSED_CLOSE, closeReason(refused.message));
    }

    function badRequest(message: string): void {
      refuse({ code: "BAD_REQUEST", message });
    }

    // why: a connection whose device stream failed ends alone, with RESET, so one broken device socket never takes the others or the daemon down.
    function drop(conn: number, connection: Connection): void {
      if (connections.get(conn) !== connection) return;
      connection.closed = true;
      connection.stream.close();
      connection.wake?.();
      connections.delete(conn);
      socket.send(
        encodeTunnelFrame(
          TUNNEL_TAG.reset,
          conn,
          JSON.stringify({ reason: "the device connection failed" }),
        ),
      );
    }

    async function received(
      conn: number,
      connection: Connection,
      payload: Uint8Array,
    ): Promise<void> {
      try {
        await connection.stream.write(payload);
      } catch {
        drop(conn, connection);
        return;
      }
      connection.inbound += payload.length;
      const granted = new Uint8Array(4);
      new DataView(granted.buffer).setUint32(0, payload.length);
      socket.send(encodeTunnelFrame(TUNNEL_TAG.credit, conn, granted));
    }

    // fallow-ignore-next-line complexity -- one HELLO answer: each branch is one refusal or step the spec lists.
    async function hello(payload: Uint8Array): Promise<void> {
      const named = parseHello(payload);
      if (typeof named === "string") {
        badRequest(named);
        return;
      }
      const tunnels = named.map(({ devicePort, kind }) => ({ kind, devicePort }));
      const held = counts.get(leaseId) ?? 0;
      const refused = refusal(tunnels, held);
      if (refused !== undefined) {
        refuse(refused);
        return;
      }
      const target = toDriverDevice(device);
      if (!options.deviceTcp.supports(device.spec.platform, target)) {
        refuse({
          code: "TUNNEL_UNSUPPORTED",
          message: unsupportedTunnelMessage(device.spec.platform, target.physical),
        });
        return;
      }
      counts.set(leaseId, held + tunnels.length);
      reserved = tunnels.length;
      for (const tunnel of tunnels) {
        let reverse: DeviceReverse;
        try {
          reverse = await options.deviceTcp.reverse(
            device.spec.platform,
            target,
            tunnel.devicePort,
            new AbortController().signal,
          );
        } catch (error) {
          await finish(true);
          const message = error instanceof Error ? error.message : String(error);
          refuse(
            error instanceof DeviceTcpError
              ? { code: error.code, message }
              : {
                  code: "TUNNEL_FAILED",
                  message: `${tunnel.kind} ${String(tunnel.devicePort)}: ${message}`,
                },
          );
          return;
        }
        // why: the socket can close while `reverse` is awaited, after `finish` read the list; a rule that arrives then is removed here.
        if (finished !== undefined) {
          if (endedWith?.remove === true && endedWith.signal?.aborted !== true) {
            await bounded(removeRule(reverse));
          }
          return;
        }
        reverses.push(reverse);
        reverse.onConnection((stream) => {
          if (finished !== undefined || connections.size >= MAX_CONNECTIONS) {
            stream.close();
            return;
          }
          const conn = nextConnection;
          nextConnection += 2;
          socket.send(encodeTunnelFrame(TUNNEL_TAG.open, conn, JSON.stringify(tunnel)));
          const connection: Connection = {
            callerEnded: false,
            closed: false,
            deviceEnded: false,
            inbound: TUNNEL_WINDOW_BYTES,
            stream,
            wake: undefined,
            window: TUNNEL_WINDOW_BYTES,
          };
          connections.set(conn, connection);
          void pump(conn, connection).catch(() => drop(conn, connection));
        });
      }
      socket.send(encodeTunnelFrame(TUNNEL_TAG.ready, 0, JSON.stringify({ tunnels })));
    }

    function onData(conn: number, connection: Connection, payload: Uint8Array): void {
      if (payload.length === 0 || payload.length > TUNNEL_MAX_DATA_BYTES) {
        badRequest(`DATA is 1 to ${String(TUNNEL_MAX_DATA_BYTES)} bytes`);
        return;
      }
      if (payload.length > connection.inbound) {
        badRequest("DATA is past the granted window");
        return;
      }
      connection.inbound -= payload.length;
      void received(conn, connection, payload);
    }

    function onCredit(connection: Connection, payload: Uint8Array): void {
      if (payload.length !== CREDIT_BYTES) {
        badRequest(`CREDIT is ${String(CREDIT_BYTES)} bytes`);
        return;
      }
      const granted = new DataView(payload.buffer, payload.byteOffset, payload.length).getUint32(0);
      if (connection.window + granted > TUNNEL_WINDOW_LIMIT) {
        badRequest(`the window is above ${String(TUNNEL_WINDOW_LIMIT)}`);
        return;
      }
      connection.window += granted;
      connection.wake?.();
    }

    // fallow-ignore-next-line complexity -- one frame dispatcher: each branch is one tag or refusal the spec lists.
    function handle(frame: TunnelFrame): void {
      if (!greeted) {
        if (frame.tag !== TUNNEL_TAG.hello) {
          badRequest("a frame came before HELLO");
          return;
        }
        greeted = true;
        void hello(frame.payload).catch((error: unknown) => {
          options.logger.warn("A tunnel's HELLO failed", { error: stableError(error) });
          void finish(true);
          refuse({ code: "TUNNEL_FAILED", message: "the worker could not set the tunnels up" });
        });
        return;
      }
      if (frame.tag === TUNNEL_TAG.hello) {
        badRequest("HELLO came twice");
        return;
      }
      if (
        frame.tag !== TUNNEL_TAG.data &&
        frame.tag !== TUNNEL_TAG.credit &&
        frame.tag !== TUNNEL_TAG.end &&
        frame.tag !== TUNNEL_TAG.reset
      ) {
        badRequest(`unknown frame tag ${String(frame.tag)}`);
        return;
      }
      // why: the worker opens odd ids, rising from 1, so an even id or one above the last it opened was never a connection; one it opened and closed is ignored.
      if (frame.conn % 2 === 0 || frame.conn > nextConnection - 2) {
        badRequest(`connection ${String(frame.conn)} was never opened`);
        return;
      }
      const connection = connections.get(frame.conn);
      if (connection === undefined) return;
      if (frame.tag === TUNNEL_TAG.data) onData(frame.conn, connection, frame.payload);
      else if (frame.tag === TUNNEL_TAG.credit) onCredit(connection, frame.payload);
      else if (frame.tag === TUNNEL_TAG.end) {
        connection.stream.end();
        connection.callerEnded = true;
        settle(frame.conn, connection);
      } else {
        connection.closed = true;
        connection.stream.close();
        connection.wake?.();
        connections.delete(frame.conn);
      }
    }

    // why: wire input never throws past this handler: whatever a frame does to the session, the holder gets BAD_REQUEST and the daemon goes on.
    socket.onMessage((data) => {
      try {
        const frame = decodeTunnelFrame(data);
        if (frame === undefined) badRequest("a frame is shorter than its 5-byte header");
        else handle(frame);
      } catch (error) {
        options.logger.warn("A tunnel frame could not be handled", { error: stableError(error) });
        badRequest("a frame could not be handled");
      }
    });
  }

  async function endSessions(
    leaseId: string | undefined,
    code: number,
    reason: string,
    removeRules: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const ending =
      leaseId === undefined
        ? [...sessions.values()].flatMap((set) => [...set])
        : [...(sessions.get(leaseId) ?? [])];
    // why: a close that races the end must not remove a rule twice, so each session finishes once, with the end's choice about removal.
    const done = ending.map((session) => session.finish(removeRules, signal));
    for (const session of ending) session.socket.close(code, closeReason(reason));
    await Promise.all(done);
  }

  return {
    attach,
    drain: () => endSessions(undefined, CLOSE_GOING_AWAY, "Simlock is stopping", true),
    // why: with the signal aborted the daemon is stopping or in maintenance, and reclaim removes the rules, so no removal starts after that; the hook returns only when the removals it began are done.
    end: (leaseId, reason, signal) =>
      endSessions(leaseId, CLOSE_LEASE_ENDED, reason, !signal.aborted, signal),
  };
}
