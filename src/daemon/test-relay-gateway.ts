import { type GatewayWorkerClient } from "../gateway/index.js";

export type CallInit = {
  readonly target?: string;
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly body?: ReadableStream<Uint8Array>;
  readonly signal?: AbortSignal;
  readonly tenant?: string;
  readonly leaseId?: string;
};

export const WORKER_ID = "wrk_a";

export function buildCall(init: CallInit) {
  const request = new Request(init.url ?? "http://gateway.test:4321/agent-device/rpc?x=1&y=2", {
    method: init.method ?? "GET",
    ...(init.headers === undefined ? {} : { headers: init.headers }),
    ...(init.body === undefined ? {} : { body: init.body, duplex: "half" }),
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  } as RequestInit);
  return {
    request,
    target: init.target ?? "echo",
    tenant: init.tenant ?? "gw.g1.alice",
    ...(init.leaseId === undefined ? {} : { leaseId: init.leaseId }),
  };
}

export interface ClientSpy {
  readonly events: string[];
}

export function spyOn(client: GatewayWorkerClient): {
  client: GatewayWorkerClient;
  spy: ClientSpy;
} {
  const spy: ClientSpy = { events: [] };
  const wrapHooks = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    const hooks = { ...(value as Record<string, unknown>) };
    const original = hooks.onRelayHead;
    if (typeof original === "function") {
      hooks.onRelayHead = (...args: unknown[]) => {
        spy.events.push("push:onRelayHead");
        return (original as (...rest: unknown[]) => unknown)(...args);
      };
    }
    return hooks;
  };
  const wrapped = new Proxy(client, {
    get(target, property) {
      const original: unknown = Reflect.get(target, property, target);
      if (typeof original !== "function") return original;
      const method = original as (...args: unknown[]) => Promise<unknown>;
      if (property === "relayRequest") {
        return async (...args: unknown[]) => {
          const value = await method.apply(target, args.map(wrapHooks));
          spy.events.push(`request-answered:${JSON.stringify(value)}`);
          return value;
        };
      }
      if (property === "relayCancel") {
        return async (...args: unknown[]) => {
          spy.events.push("cancel-sent");
          const value = await method.apply(target, args);
          spy.events.push("cancel-answered");
          return value;
        };
      }
      return method.bind(target);
    },
  });
  return { client: wrapped, spy };
}
