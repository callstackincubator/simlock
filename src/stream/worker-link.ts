import { captureStream, type CapturedStream } from "./capture.js";
import type { CaptureRegistry, RunningCapture } from "./captures.js";
import type { StreamCaller } from "./caller.js";
import { notStreamable, streamUnavailable, unknownLease } from "./refusal.js";
import type { StreamLink } from "./service.js";

export interface StreamLeaseOwner {
  readonly ownerId: string;
  readonly requesterId: string;
}

export interface StreamDevice {
  readonly address: string;
  readonly physical: boolean;
  readonly platform: string;
}

export interface StreamRegistry {
  leaseOwner(leaseId: string): StreamLeaseOwner | undefined;
  deviceOfLease(leaseId: string): StreamDevice | undefined;
}

export interface WorkerStreamLinkOptions {
  readonly registry: StreamRegistry;
  readonly command: string;
  readonly args: readonly string[];
  readonly leaseEnvironment: Readonly<Record<string, string>>;
  readonly onLog?: (line: string) => void;
  readonly available?: () => Promise<boolean>;
  readonly captures?: CaptureRegistry;
}

const noopRegistry: CaptureRegistry = {
  leases: () => [],
  stop: () => 0,
  track: (_leaseId, capture) => capture,
};

export function createWorkerStreamLink(options: WorkerStreamLinkOptions): StreamLink {
  return {
    async serve(leaseId, caller, signal): Promise<CapturedStream> {
      // why: ownership is proved before anything is asked of the machine. A link that looked for its
      // capture program first would answer an agent with one refusal for a lease this worker holds and
      // another for a lease that does not exist, which is a way of listing the fleet's leases.
      requireLease(options.registry, leaseId, caller);
      if ((await options.available?.()) === false) {
        throw streamUnavailable(`No screen capture program to run at ${options.command}`);
      }
      const device = options.registry.deviceOfLease(leaseId);
      if (device === undefined) throw unknownLease(leaseId);
      if (device.platform !== "ios" || device.physical) {
        throw notStreamable(
          "This lease is not on an iOS simulator, and a live screen is captured from a simulator only",
        );
      }
      // why: the capture registers itself through `onEnd` before the handle it will close exists, so
      // the closure reads `running` when the tool actually ends; registering late would let a tool
      // that died in its first milliseconds leave an entry nothing can clear.
      let running: RunningCapture = { close: () => undefined };
      let stream: CapturedStream;
      try {
        stream = await captureStream({
          args: [...options.args, device.address],
          command: options.command,
          env: { ...process.env, ...options.leaseEnvironment },
          onEnd: () => running.close(),
          ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
        });
      } catch (error) {
        // why: a tool that died before its first frame is an unavailable picture rather than a broken
        // request -- the lease is fine and the retry that succeeds needs no different ask, so the
        // status says "not right now" and not "you did something wrong".
        throw streamUnavailable(error instanceof Error ? error.message : String(error));
      }
      running = (options.captures ?? noopRegistry).track(leaseId, stream);
      // why: the listener, and not only the body's cancel path, because a request aborted before its
      // first frame has no body being read yet to cancel -- which is what a page opened and closed
      // quickly does, and it would otherwise leave a capture running for a viewer that is gone.
      if (signal.aborted) running.close();
      else signal.addEventListener("abort", () => running.close(), { once: true });
      return { ...stream, close: () => running.close() };
    },
  };
}

// why: ownership is proved against this worker's own registry rather than taken from whoever relayed
// the request. A caller that names a requester is checked against the lease's requester (the rule
// `device.exec` follows, ADR 0005 §19b); one that names none is checked against the principal that
// owns the lease. An unknown lease and one held by someone else get the same answer, because an
// agent cannot be allowed to discover which leases exist by asking for pictures of them.
function requireLease(registry: StreamRegistry, leaseId: string, caller: StreamCaller): void {
  const owner = registry.leaseOwner(leaseId);
  if (owner === undefined) throw unknownLease(leaseId);
  if (caller.role === "operator") return;
  const held =
    caller.requesterId === undefined
      ? owner.ownerId === caller.principal
      : owner.requesterId === caller.requesterId;
  if (!held) throw unknownLease(leaseId);
}
