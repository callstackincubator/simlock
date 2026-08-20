/**
 * `pitlane top`: a live, read-only Ink dashboard over daemon state.
 *
 * This module is loaded lazily (see `loadDefaultTopUi` in `../index.ts`), the
 * same way `loadMcpStdio` lazily loads the MCP frontend, so every other
 * command never pays React/Ink's import cost. Nothing in here is unit
 * tested directly — the parsing and derivation logic it renders lives in
 * `./view-model.ts`, which is pure and fully tested; this file is the thin,
 * un-tested rendering layer on top of it.
 */
import { Box, render, Text, useApp, useInput, useStdin, useStdout } from "ink";
import React, { useEffect, useSyncExternalStore } from "react";

import { DaemonClientError, type DaemonConnection } from "../../daemon-client/protocol.js";
import {
  buildMeter,
  formatCoarseDuration,
  formatDuration,
  formatRelativeAge,
  parseIdleShutdownAfterMs,
  parseStatus,
  resolveWidth,
  meterLayout,
  summarizeEvent,
  type DeviceRow,
  type EventSummary,
  type RowState,
  type TopViewModel,
} from "./view-model.js";

interface Signals {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface TopRunOptions {
  readonly connection: DaemonConnection;
  readonly now: () => number;
  readonly signals: Signals;
}

export type TopUiRunner = (options: TopRunOptions) => Promise<number>;

const REFRESH_DEBOUNCE_MS = 150;
const POLL_INTERVAL_MS = 5_000;
const METER_WIDTH = 20;

/**
 * Drives the daemon connection (initial fetch, event-triggered and polled
 * refreshes, close handling) and mounts the Ink app. All impure I/O — real
 * timers, the real terminal — lives here; `App` and below are pure renders
 * of whatever `TopStore` currently holds, re-rendering whenever it changes.
 */
// fallow-ignore-next-line unused-export -- CLI routing invokes this public frontend entrypoint.
export async function runTopUi(options: TopRunOptions): Promise<number> {
  const { connection, now, signals } = options;

  const [statusRaw, shutdownAfterMs] = await Promise.all([
    connection.request("status.get", {}),
    connection.request("config.get", {}).then(parseIdleShutdownAfterMs).catch(returnUndefined),
  ]);

  const store = new TopStore(parseViewModel(statusRaw, now(), shutdownAfterMs));

  const refresh = (): void => {
    connection
      .request("status.get", {})
      .then((raw) => store.setViewModel(parseViewModel(raw, now(), shutdownAfterMs)))
      .catch(returnUndefined);
  };

  let debounceTimer: NodeJS.Timeout | undefined;
  const scheduleRefresh = (): void => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
  };

  const deviceLabel = (id: string): string | undefined =>
    store.getSnapshot().viewModel.devices.find((device) => device.id === id)?.model;

  const unsubscribePush = connection.onPush((kind, payload) => {
    if (kind !== "event") return;
    const summary = summarizeEvent(payload, now(), deviceLabel);
    if (summary !== undefined)
      store.setLastEvent({ ...summary, timestampMs: now() - summary.ageMs });
    scheduleRefresh();
  });

  // Read-only dashboard: if subscribing fails, the 5s poll below still keeps the view live.
  await connection.request("events.subscribe", {}).catch(returnUndefined);

  const pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
  const instance = render(<App store={store} now={now} />, {
    alternateScreen: true,
    exitOnCtrlC: true,
  });
  const unsubscribeClose = connection.onClose(() => {
    store.setCloseError(
      new DaemonClientError("DAEMON_CONNECTION_LOST", "Daemon connection closed"),
    );
  });
  // Belt-and-suspenders alongside Ink's own Ctrl+C handling: Ink can only capture
  // Ctrl+C as *input* when stdin is a TTY in raw mode (see `App`'s `isRawModeSupported`
  // guard). Piped/non-interactive stdin gets no such input, so an external SIGINT/SIGTERM
  // (Ctrl+C at a controlling terminal that isn't stdin, `kill`, `timeout`, …) still needs
  // an explicit handler here to unmount and clean up rather than dying with no cleanup at all.
  const handleSignal = (): void => instance.unmount();
  signals.on("SIGINT", handleSignal);
  signals.on("SIGTERM", handleSignal);

  try {
    await instance.waitUntilExit();
  } finally {
    signals.off("SIGINT", handleSignal);
    signals.off("SIGTERM", handleSignal);
    clearInterval(pollTimer);
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    unsubscribePush();
    // Unsubscribe before our own close() below, so it can't re-fire this listener.
    unsubscribeClose();
    await connection.request("events.unsubscribe", {}).catch(returnUndefined);
    await connection.close();
  }
  return 0;
}

function parseViewModel(
  raw: unknown,
  now: number,
  shutdownAfterMs: number | undefined,
): TopViewModel {
  return parseStatus(raw, { now, ...(shutdownAfterMs === undefined ? {} : { shutdownAfterMs }) });
}

function returnUndefined(): undefined {
  return undefined;
}

interface LastEventState extends EventSummary {
  /** Wall-clock moment the event was received, so age can be recomputed fresh on every render. */
  readonly timestampMs: number;
}

interface Snapshot {
  readonly viewModel: TopViewModel;
  readonly lastEvent: LastEventState | undefined;
  readonly closeError: DaemonClientError | undefined;
}

/**
 * Minimal external store so the Ink tree only re-renders when data actually
 * changes. `getSnapshot()` must return the *same* object reference between
 * updates — `useSyncExternalStore` calls it on every render to decide
 * whether anything changed, and a freshly-allocated object each call reads
 * as "always changed", which is an infinite render loop. So the snapshot is
 * built once per update, not once per `getSnapshot()` call.
 */
class TopStore {
  #snapshot: Snapshot;
  readonly #listeners = new Set<() => void>();

  constructor(initial: TopViewModel) {
    this.#snapshot = { closeError: undefined, lastEvent: undefined, viewModel: initial };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): Snapshot => this.#snapshot;

  setViewModel(viewModel: TopViewModel): void {
    this.#snapshot = { ...this.#snapshot, viewModel };
    this.#emit();
  }

  setLastEvent(lastEvent: LastEventState): void {
    this.#snapshot = { ...this.#snapshot, lastEvent };
    this.#emit();
  }

  setCloseError(closeError: DaemonClientError): void {
    this.#snapshot = { ...this.#snapshot, closeError };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

function App({
  store,
  now,
}: {
  readonly store: TopStore;
  readonly now: () => number;
}): React.ReactElement {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { isRawModeSupported } = useStdin();

  // The daemon-death path (below) can only reach `exit()` from inside the React
  // tree — Ink's public `render()` return value silently drops any error passed
  // to its `unmount()`, so a close error is threaded through the store instead
  // and turned into a real, `waitUntilExit()`-rejecting exit here.
  const { closeError } = snapshot;
  useEffect(() => {
    if (closeError !== undefined) exit(closeError);
  }, [closeError, exit]);

  // Guarded: enabling raw mode throws when stdin isn't a TTY (piped/non-interactive),
  // and `q`/Esc obviously can't be typed there anyway — Ctrl+C (SIGTERM/SIGINT) still
  // tears the process down in that case, just without this graceful key-driven exit.
  // `isRawModeSupported` is `stdin.isTTY`, which reads `undefined` (not `false`) off a
  // TTY, so it must be coerced — `useInput` only skips enabling raw mode on `=== false`.
  useInput(
    (input, key) => {
      if (input === "q" || key.escape) exit();
    },
    { isActive: isRawModeSupported === true },
  );

  // A real TTY populates `stdout.columns`, and that is the authoritative value.
  // On a pipe it is `undefined` while Ink's own layout engine still honours
  // `COLUMNS`; falling back to it keeps our column budget and Ink's agreeing,
  // instead of us assuming 80 and Ink wrapping the rules at something narrower.
  const width = resolveWidth(stdout.columns, process.env.COLUMNS);
  return (
    <Dashboard
      viewModel={snapshot.viewModel}
      lastEvent={snapshot.lastEvent}
      width={width}
      now={now()}
    />
  );
}

const STATE_LABEL: Readonly<Record<RowState, string>> = {
  busy: "busy",
  leased: "leased",
  shutdown: "off",
  warm: "warm",
};
const STATE_BULLET: Readonly<Record<RowState, string>> = {
  busy: "◐",
  leased: "●",
  shutdown: "·",
  warm: "○",
};
const STATE_COLOR: Readonly<Record<RowState, string | undefined>> = {
  busy: "yellow",
  leased: "green",
  shutdown: undefined,
  warm: "cyan",
};
const SEGMENT_COLOR: Readonly<Record<"leased" | "warm" | "busy" | "empty", string | undefined>> = {
  busy: "yellow",
  empty: undefined,
  leased: "green",
  warm: "cyan",
};

/** `exactOptionalPropertyTypes` rejects `color={undefined}` on Ink's `Text`, so omit the key entirely instead. */
function colorProp(color: string | undefined): { readonly color?: string } {
  return color === undefined ? {} : { color };
}

function Dashboard({
  viewModel,
  lastEvent,
  width,
  now,
}: {
  readonly viewModel: TopViewModel;
  readonly lastEvent: LastEventState | undefined;
  readonly width: number;
  readonly now: number;
}): React.ReactElement {
  const showAgent = width >= 72;
  const showOs = width >= 60;
  const rows = viewModel.devices.map(deviceRowText);
  const columns: ColumnWidths = {
    device: columnWidth(
      rows.map((row) => row.device),
      10,
      24,
    ),
    for: columnWidth(
      rows.map((row) => row.forText),
      4,
      12,
    ),
    os: showOs
      ? columnWidth(
          rows.map((row) => row.os),
          2,
          8,
        )
      : 0,
    requester: showAgent
      ? columnWidth(
          rows.map((row) => row.agent),
          5,
          16,
        )
      : 0,
    state: columnWidth(Object.values(STATE_LABEL), 4, 8) + 2,
  };
  const rule = "─".repeat(Math.max(20, Math.min(width - 2, 74)));

  return (
    <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
      <HeaderLine
        health={viewModel.health}
        deviceCount={viewModel.devices.length}
        width={rule.length}
      />
      <Box height={1} />
      <MeterLine viewModel={viewModel} width={width} />
      <Box height={1} />
      <Text dimColor>{rule}</Text>
      <TableHeader columns={columns} showOs={showOs} showAgent={showAgent} />
      {rows.map((row) => (
        <DeviceLine
          key={row.id}
          row={row}
          columns={columns}
          showOs={showOs}
          showAgent={showAgent}
        />
      ))}
      <Text dimColor>{rule}</Text>
      {viewModel.queueDepth > 0 ? (
        <>
          <Box height={1} />
          <Text>{viewModel.queueDepth} waiting</Text>
        </>
      ) : null}
      <Box height={1} />
      <LastEventLine lastEvent={lastEvent} now={now} width={width} />
      <Text dimColor>q quit</Text>
    </Box>
  );
}

/**
 * Constrained to the rule width rather than the terminal width: a
 * `space-between` row spanning a 200-column terminal strands the device count
 * far off to the right, visually disconnected from the body beneath it. Both
 * ends stay tied to the same column the rules and table occupy.
 */
function HeaderLine({
  health,
  deviceCount,
  width,
}: {
  readonly width: number;
  readonly health: TopViewModel["health"];
  readonly deviceCount: number;
}): React.ReactElement {
  const healthColor = health === "running" ? "green" : health === "failed" ? "red" : "yellow";
  return (
    <Box justifyContent="space-between" width={width}>
      <Text>
        <Text bold> PITLANE </Text>
        <Text color={healthColor}>● {health}</Text>
      </Text>
      <Text dimColor>{deviceCount} devices</Text>
    </Box>
  );
}

function MeterLine({
  viewModel,
  width,
}: {
  readonly viewModel: TopViewModel;
  readonly width: number;
}): React.ReactElement {
  const { counts, capacity } = viewModel;
  const { barWidth, showPlatforms } = meterLayout(width, capacity, METER_WIDTH);
  const meter = buildMeter(counts, capacity.global, barWidth);
  const overLimit = meter.overLimit || viewModel.overLimit;
  const emptyWidth = meter.segments.find((segment) => segment.kind === "empty")?.width ?? 0;
  const bar = overLimit ? (
    <Text color="red">
      {"█".repeat(barWidth - emptyWidth)}
      {"░".repeat(emptyWidth)}
    </Text>
  ) : (
    <Text>
      {meter.segments.map((segment) => (
        <Text
          key={segment.kind}
          dimColor={segment.kind === "empty"}
          {...colorProp(SEGMENT_COLOR[segment.kind])}
        >
          {(segment.kind === "empty" ? "░" : "█").repeat(segment.width)}
        </Text>
      ))}
    </Text>
  );
  // Each legend bullet carries its own state color, tying the counts back to the
  // matching segment in the bar above; only the words stay dim.
  const legend = (["leased", "warm", "busy"] as const).filter((kind) => counts[kind] > 0);

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>Running </Text>
        {bar}
        <Text>
          {"  "}
          {capacity.global.running}/{capacity.global.maxRunning}
        </Text>
        {showPlatforms ? (
          <Text>
            <Text dimColor>{"   ios "}</Text>
            {capacity.ios.running}/{capacity.ios.maxRunning}
            <Text dimColor>{"   android "}</Text>
            {capacity.android.running}/{capacity.android.maxRunning}
          </Text>
        ) : null}
      </Box>
      {legend.length === 0 ? null : (
        <Text>
          {"  "}
          {legend.map((kind, index) => (
            <Text key={kind}>
              {index === 0 ? "" : "   "}
              <Text {...colorProp(SEGMENT_COLOR[kind])}>●</Text>
              <Text dimColor>
                {" "}
                {counts[kind]} {kind}
              </Text>
            </Text>
          ))}
        </Text>
      )}
    </Box>
  );
}

interface ColumnWidths {
  readonly state: number;
  readonly device: number;
  readonly os: number;
  readonly requester: number;
  readonly for: number;
}

function TableHeader({
  columns,
  showOs,
  showAgent,
}: {
  readonly columns: ColumnWidths;
  readonly showOs: boolean;
  readonly showAgent: boolean;
}): React.ReactElement {
  return (
    <Text dimColor>
      {" "}
      {"STATE".padEnd(columns.state)} {"DEVICE".padEnd(columns.device)}{" "}
      {showOs ? `${"OS".padEnd(columns.os)} ` : ""}
      {showAgent ? `${"AGENT".padEnd(columns.requester)} ` : ""}
      {"FOR".padStart(columns.for)}
    </Text>
  );
}

interface RowText {
  readonly id: string;
  readonly state: RowState;
  readonly device: string;
  readonly os: string;
  readonly agent: string;
  readonly forText: string;
  readonly countdown: string;
  readonly flagged: boolean;
}

function deviceRowText(device: DeviceRow): RowText {
  const countdown =
    device.shutdownInMs === undefined ? "" : `   ↓ ${formatDuration(device.shutdownInMs)}`;
  return {
    agent: device.agent ?? "—",
    countdown,
    device: device.model,
    flagged: device.flagged,
    forText:
      device.state === "shutdown"
        ? formatCoarseDuration(device.forMs)
        : formatDuration(device.forMs),
    id: device.id,
    os: device.osVersion,
    state: device.state,
  };
}

function columnWidth(values: readonly string[], min: number, max: number): number {
  const longest = values.reduce((width, value) => Math.max(width, value.length), 0);
  return Math.min(Math.max(longest, min), max);
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width);
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function DeviceLine({
  row,
  columns,
  showOs,
  showAgent,
}: {
  readonly row: RowText;
  readonly columns: ColumnWidths;
  readonly showOs: boolean;
  readonly showAgent: boolean;
}): React.ReactElement {
  const color = STATE_COLOR[row.state];
  const stateText = `${STATE_BULLET[row.state]} ${STATE_LABEL[row.state]}`.padEnd(columns.state);
  return (
    <Text>
      {" "}
      <Text dimColor={color === undefined} {...colorProp(color)}>
        {stateText}
      </Text>{" "}
      <Text>{truncate(row.device, columns.device)}</Text>{" "}
      {showOs ? (
        <>
          <Text dimColor>{truncate(row.os, columns.os)}</Text>{" "}
        </>
      ) : null}
      {showAgent ? (
        <>
          <Text dimColor={row.agent === "—"}>{truncate(row.agent, columns.requester)}</Text>{" "}
        </>
      ) : null}
      <Text>{row.forText.padStart(columns.for)}</Text>
      {row.countdown === "" ? null : <Text dimColor>{row.countdown}</Text>}
      {row.flagged ? <Text color="red"> !</Text> : null}
    </Text>
  );
}

function LastEventLine({
  lastEvent,
  now,
  width,
}: {
  readonly lastEvent: LastEventState | undefined;
  readonly now: number;
  readonly width: number;
}): React.ReactElement {
  if (lastEvent === undefined) return <Box height={1} />;
  const age = formatRelativeAge(Math.max(0, now - lastEvent.timestampMs));
  const line = `${lastEvent.event}  ${lastEvent.summary}`;
  return (
    <Text dimColor>
      {truncate(line, Math.max(10, width - 2 - age.length - 1))} {age}
    </Text>
  );
}
