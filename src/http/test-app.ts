import { EventBus } from "../bus/index.js";
import { UnknownLeaseError } from "../core/index.js";
import { OwnerRoutedFactBus } from "../daemon/owner-routed-facts.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import type { Auth, Identity } from "../auth/index.js";
import { fakeAuth, tokenIdentity } from "../auth/testing.js";
import { createHttpApp, type HttpGatewayDeps } from "./app.js";
import {
  FakeDispatcher,
  FakeRegistry,
  sequenceIdGenerator,
  waitForDispatch,
  noLeaseFiles,
} from "./test-fakes.js";

export function buildHarness(
  overrides: {
    readonly leaseRequests?: HttpGatewayDeps["leaseRequests"];
    readonly registry?: HttpGatewayDeps["registry"];
    readonly answerDownloadsEarly?: boolean;
    readonly identities?: Readonly<Record<string, Identity>>;
    readonly auth?: Auth;
    readonly mounts?: HttpGatewayDeps["mounts"];
    readonly leaseFiles?: (parts: {
      readonly clock: FakeClock;
      readonly logger: JsonLinesLogger;
    }) => HttpGatewayDeps["leaseFiles"];
  } = {},
) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const dispatcher = new FakeDispatcher(clock);
  const registry = new FakeRegistry();
  const ownerRoutedFacts = new OwnerRoutedFactBus(eventBus, registry);
  const auth =
    overrides.auth ??
    fakeAuth(
      new Map<string, Identity>([
        ["slk_agent", tokenIdentity("tok_agent", "agent")],
        ["slk_other", tokenIdentity("tok_other", "agent")],
        ["slk_operator", tokenIdentity("tok_operator", "operator")],
        [
          "slk_labelled",
          { ambient: false, name: "ci-runner", principal: "tok_9f2c", role: "agent", via: "token" },
        ],
        ...Object.entries(overrides.identities ?? {}),
      ]),
    );
  const logSink = new MemoryLogSink();
  const logger = new JsonLinesLogger({ clock, sink: logSink });

  dispatcher.handlers["lease.list"] = (_input, session) => ({
    leases: registry.leases.filter(
      (lease) => session.role === "admin" || lease.ownerId === session.principal,
    ),
  });

  dispatcher.handlers["lease.get"] = (input: { leaseId: string }, session) => {
    const lease = registry.leases.find(
      (candidate) =>
        candidate.id === input.leaseId &&
        (session.role === "admin" || candidate.ownerId === session.principal),
    );
    if (lease === undefined) throw new UnknownLeaseError(input.leaseId);
    return { lease };
  };

  const app = createHttpApp({
    clock,
    dispatch: (op, input, session) => dispatcher.dispatch(op, input, session) as never,
    eventBus,
    idGenerator: sequenceIdGenerator("gw"),
    leaseRequests: overrides.leaseRequests ?? dispatcher.requests,
    logger,
    ownerRoutedFacts,
    registry: overrides.registry ?? registry,
    auth,
    ...(overrides.mounts === undefined ? {} : { mounts: overrides.mounts }),
    leaseFiles: overrides.leaseFiles?.({ clock, logger }) ?? noLeaseFiles,
    ...(overrides.answerDownloadsEarly === undefined
      ? {}
      : { answerDownloadsEarly: overrides.answerDownloadsEarly }),
  });

  return { app, clock, dispatcher, eventBus, logSink, registry };
}

export type App = ReturnType<typeof buildHarness>["app"];

export const agentAuth = { authorization: "Bearer slk_agent" };
export const otherAgentAuth = { authorization: "Bearer slk_other" };
export const operatorAuth = { authorization: "Bearer slk_operator" };
export const defaultBody = { device: "iPhone 17 Pro", platform: "ios" };

// why: a route's validators add microtask hops before its handler runs, so a test cannot count ticks.
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function postLeaseRequest(
  app: App,
  body: Record<string, unknown>,
  headers: Record<string, string> = agentAuth,
): Promise<Response> {
  return Promise.resolve(
    app.request("/v1/lease-requests", {
      body: JSON.stringify(body),
      headers: { ...headers, "content-type": "application/json" },
      method: "POST",
    }),
  );
}

export async function createLeaseRequest(
  app: App,
  dispatcher: FakeDispatcher,
  body: Record<string, unknown> = defaultBody,
  headers: Record<string, string> = agentAuth,
): Promise<{ readonly id: string; readonly callIndex: number }> {
  const responsePromise = postLeaseRequest(app, body, headers);
  const call = await waitForDispatch(dispatcher, "lease.request");
  const callIndex = dispatcher.calls.indexOf(call);
  call.session.onProgress?.({ queuePosition: 1, stage: "queued" });
  const response = await responsePromise;
  const { request } = (await response.json()) as { request: { id: string } };
  return { callIndex, id: request.id };
}

interface SseFrame {
  readonly event?: string;
  readonly data: unknown;
}

function parseSseFrame(raw: string): SseFrame | undefined {
  if (raw.startsWith(":")) return undefined;
  let event: string | undefined;
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  return { data: JSON.parse(data) as unknown, ...(event === undefined ? {} : { event }) };
}

function splitCompleteFrames(buffer: string): { complete: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { complete: parts, rest };
}

export async function readSseFrames(response: Response, count: number): Promise<SseFrame[]> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: SseFrame[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { complete, rest } = splitCompleteFrames(buffer);
    buffer = rest;
    for (const raw of complete) {
      if (frames.length >= count) break;
      const frame = parseSseFrame(raw);
      if (frame !== undefined) frames.push(frame);
    }
  }
  await reader.cancel();
  return frames;
}
