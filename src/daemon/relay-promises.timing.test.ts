import { afterEach, describe, expect, it } from "vitest";

import type { DispatchSession } from "./dispatch.js";
import type { RelayTarget } from "./relay.js";
import type { DaemonServer } from "./server.js";
import {
  cleanUp,
  digestOf,
  MIB,
  KIB,
  patternDigest,
  patternDigestSwapped,
  patternStream,
  readParts,
  sleep,
  startCountingProxy,
  startFleet,
  type CountingProxy,
} from "./test-relay-support.js";

const GIB = 1024 * MIB;
const WORKER_TENANT = "gw.g1.alice";

const agent: DispatchSession = {
  manageEventSubscription: () => undefined,
  principal: "fleet-agent-1",
  role: "agent",
};

describe("transfers through a gateway keep their promises", () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];
  const proxies: CountingProxy[] = [];
  let behavior: RelayTarget = () => Promise.resolve(new Response("ok"));
  const target: RelayTarget = (request, tenant, leaseId) => behavior(request, tenant, leaseId);

  afterEach(async () => {
    behavior = () => Promise.resolve(new Response("ok"));
    await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()));
    await cleanUp(daemons, directories);
  });

  async function fleet() {
    const started = await startFleet(
      { daemons, directories, target },
      {
        gatewayUrl: async (port) => {
          const proxy = await startCountingProxy(port);
          proxies.push(proxy);
          return `ws://127.0.0.1:${String(proxy.port)}`;
        },
      },
    );
    const proxy = proxies[0] as CountingProxy;
    return { ...started, proxy };
  }

  function call(
    url: string,
    init: { readonly method?: string; readonly body?: ReadableStream<Uint8Array> } = {},
  ) {
    const request = new Request(`http://gateway.test:4321/agent-device/${url}`, {
      method: init.method ?? "GET",
      ...(init.body === undefined ? {} : { body: init.body, duplex: "half" }),
    } as RequestInit);
    return { request, target: "echo", tenant: WORKER_TENANT };
  }

  async function drain(stream: ReadableStream<Uint8Array> | null): Promise<number> {
    if (stream === null) return 0;
    const reader = stream.getReader();
    let total = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) return total;
      total += step.value.length;
    }
  }

  function median(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] as number;
  }

  function carriedTotal(proxy: CountingProxy): number {
    const { down, up } = proxy.carried();
    return up + down;
  }

  async function acceptingUploads(): Promise<void> {
    behavior = async (request) => {
      await drain(request.body);
      return new Response("done");
    };
  }

  it("a 100 MiB upload through the gateway puts at most 105 MiB on the uplink", async () => {
    await acceptingUploads();
    const { proxy, relay, workerId } = await fleet();
    proxy.reset();

    const response = await relay.relay(
      workerId,
      call("upload", { body: patternStream(100 * MIB, 3), method: "PUT" }),
    );
    await response.text();
    const carried = carriedTotal(proxy);

    expect(carried).toBeGreaterThanOrEqual(100 * MIB);
    expect(carried).toBeLessThanOrEqual(105 * MIB);
  }, 120_000);

  it("a 1 GiB upload through the gateway puts at most 1.05 GiB on the uplink, and so does a 1 GiB download, each measured on its own", async () => {
    behavior = async (request) => {
      if (request.method === "PUT") {
        await drain(request.body);
        return new Response("done");
      }
      return new Response(patternStream(GIB, 4));
    };
    const { proxy, relay, workerId } = await fleet();

    proxy.reset();
    const put = await relay.relay(
      workerId,
      call("upload", { body: patternStream(GIB, 3), method: "PUT" }),
    );
    await put.text();
    const uploaded = carriedTotal(proxy);

    proxy.reset();
    const get = await relay.relay(workerId, call("download"));
    const received = await drain(get.body);
    const downloaded = carriedTotal(proxy);

    expect(uploaded).toBeGreaterThanOrEqual(GIB);
    expect(uploaded).toBeLessThanOrEqual(1.05 * GIB);
    expect(received).toBe(GIB);
    expect(downloaded).toBeGreaterThanOrEqual(GIB);
    expect(downloaded).toBeLessThanOrEqual(1.05 * GIB);
  }, 180_000);

  // fallow-ignore-next-line complexity -- one measurement: its windows and delays are read in order, and splitting them would hide what each number is measured against.
  it("while 10 relays each upload 64 MiB and 10 each download 64 MiB to one worker, a forwarded `lease.renew` and a relayed request whose target answers at once each answer at most 1 s later than with nothing running, and each of the 20 relays carried at least 1 MiB in the second before and the second after each answer came back", async () => {
    const samples = new Map<string, { at: number; total: number }[]>();
    const progress = (id: string, total: number) => {
      const list = samples.get(id) ?? [];
      list.push({ at: performance.now(), total });
      samples.set(id, list);
    };
    const finishedAt = new Map<string, number>();
    behavior = async (request) => {
      const url = new URL(request.url);
      const id = url.searchParams.get("id") ?? "";
      if (url.pathname.endsWith("/upload")) {
        const reader = request.body?.getReader();
        let total = 0;
        for (;;) {
          const step = await reader?.read();
          if (step === undefined || step.done) break;
          total += step.value.length;
          progress(id, total);
        }
        finishedAt.set(id, performance.now());
        return new Response("done");
      }
      if (url.pathname.endsWith("/download")) {
        return new Response(patternStream(64 * MIB, 6));
      }
      return new Response("ok");
    };
    const { gateway, relay, workerId } = await fleet();
    const grant = await gateway.dispatch(
      "lease.request",
      { model: "Pixel-A", noWait: true, platform: "android" },
      agent,
    );
    const timeOf = async (work: () => Promise<unknown>): Promise<number> => {
      const started = performance.now();
      await work();
      return performance.now() - started;
    };
    const renew = () => gateway.dispatch("lease.renew", { leaseId: grant.lease.id }, agent);
    const small = async () => (await relay.relay(workerId, call("small"))).text();

    const renewDelays: number[] = [];
    const smallDelays: number[] = [];
    const quietWindows: string[] = [];
    for (let run = 0; run < 5; run += 1) {
      const idleRenew = await timeOf(renew);
      const idleSmall = await timeOf(small);
      samples.clear();
      finishedAt.clear();
      const downloads: Promise<number>[] = [];
      const uploads: Promise<unknown>[] = [];
      for (let index = 0; index < 10; index += 1) {
        uploads.push(
          relay
            .relay(
              workerId,
              call(`upload?id=u${String(index)}`, {
                body: patternStream(64 * MIB, 5),
                method: "PUT",
              }),
            )
            .then((response) => response.text()),
        );
        downloads.push(
          relay
            .relay(workerId, call(`download?id=d${String(index)}`))
            .then((response) => drain(response.body)),
        );
      }
      await sleep(500);
      const answers: number[] = [];
      renewDelays.push((await timeOf(renew)) - idleRenew);
      answers.push(performance.now());
      smallDelays.push((await timeOf(small)) - idleSmall);
      answers.push(performance.now());
      await sleep(1_000);
      for (const answer of answers) {
        for (let index = 0; index < 10; index += 1) {
          const id = `u${String(index)}`;
          const list = samples.get(id) ?? [];
          const within = (from: number, to: number) => {
            const inside = list.filter((sample) => sample.at >= from && sample.at <= to);
            const first = inside[0]?.total ?? 0;
            const last = inside.at(-1)?.total ?? 0;
            return last - first;
          };
          if (within(answer - 1_000, answer) < MIB || within(answer, answer + 1_000) < MIB) {
            quietWindows.push(`${id}@${String(Math.round(answer))}`);
          }
          const done = finishedAt.get(id);
          if (done !== undefined && done < answer + 1_000)
            quietWindows.push(`${id} finished early`);
        }
      }
      await Promise.all([...uploads, ...downloads]);
    }

    expect(quietWindows).toEqual([]);
    expect(median(renewDelays)).toBeLessThanOrEqual(1_000);
    expect(median(smallDelays)).toBeLessThanOrEqual(1_000);
  }, 300_000);

  it("while one relay's caller reads none of its 1 GiB response, another relay's 256 MiB upload to the same worker takes at most 1.5 times as long as with nothing else running", async () => {
    behavior = async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/upload")) {
        await drain(request.body);
        return new Response("done");
      }
      return new Response(patternStream(GIB, 8));
    };
    const { relay, workerId } = await fleet();
    const upload = async (): Promise<number> => {
      const started = performance.now();
      const response = await relay.relay(
        workerId,
        call("upload", { body: patternStream(256 * MIB, 7), method: "PUT" }),
      );
      await response.text();
      return performance.now() - started;
    };

    const ratios: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const alone = await upload();
      const slow = await relay.relay(workerId, call("download"));
      await sleep(500);
      const beside = await upload();
      await slow.body?.cancel();
      ratios.push(beside / alone);
    }

    expect(median(ratios)).toBeLessThanOrEqual(1.5);
  }, 300_000);

  it("while the gateway's caller reads none of a 2 GiB response, the target has handed over at most 8 MiB after 5 s; reading it then gets every byte, in order", async () => {
    let handedOver = 0;
    behavior = () => {
      const source = patternStream(2 * GIB, 11);
      const reader = source.getReader();
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              const step = await reader.read();
              if (step.done) controller.close();
              else {
                handedOver += step.value.length;
                controller.enqueue(step.value);
              }
            },
          }),
        ),
      );
    };
    const { relay, workerId } = await fleet();

    const response = await relay.relay(workerId, call("download"));
    await sleep(5_000);
    const afterFiveSeconds = handedOver;
    const body = await readParts(response.body);
    const digest = digestOf(body);

    expect(afterFiveSeconds).toBeGreaterThan(0);
    expect(afterFiveSeconds).toBeLessThanOrEqual(8 * MIB);
    expect(digest).toBe(patternDigest(2 * GIB, 11));
  }, 180_000);

  it("while the target reads none of a 2 GiB upload, the gateway has read at most 8 MiB of the caller's body after 5 s; once the target reads, every byte arrives, in order", async () => {
    let readByGateway = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let received = "";
    behavior = async (request) => {
      await released;
      received = digestOf(await readParts(request.body));
      return new Response("done");
    };
    const { relay, workerId } = await fleet();
    const source = patternStream(2 * GIB, 12, { onPull: () => (readByGateway += MIB) });

    const pending = relay.relay(workerId, call("upload", { body: source, method: "PUT" }));
    await sleep(5_000);
    const afterFiveSeconds = readByGateway;
    release();
    const response = await pending;
    await response.text();

    expect(afterFiveSeconds).toBeGreaterThan(0);
    expect(afterFiveSeconds).toBeLessThanOrEqual(8 * MIB);
    expect(received).toBe(patternDigest(2 * GIB, 12));
  }, 180_000);

  it("a 2 GiB upload through the gateway arrives byte for byte", async () => {
    let received = "";
    let size = 0;
    behavior = async (request) => {
      const parts = await readParts(request.body);
      size = parts.reduce((total, part) => total + part.length, 0);
      received = digestOf(parts);
      return new Response("done");
    };
    const { relay, workerId } = await fleet();

    const response = await relay.relay(
      workerId,
      call("upload", { body: patternStream(2 * GIB, 13), method: "PUT" }),
    );
    await response.text();

    expect(size).toBe(2 * GIB);
    expect(received).toBe(patternDigest(2 * GIB, 13));
  }, 180_000);

  it("a 2 GiB download through the gateway arrives byte for byte and finishes within 90 s", async () => {
    behavior = () => Promise.resolve(new Response(patternStream(2 * GIB, 14)));
    const { relay, workerId } = await fleet();

    const started = performance.now();
    const response = await relay.relay(workerId, call("download"));
    const parts = await readParts(response.body);
    const elapsedMs = performance.now() - started;

    expect(digestOf(parts)).toBe(patternDigest(2 * GIB, 14));
    expect(elapsedMs).toBeLessThanOrEqual(90_000);
  }, 180_000);

  it("swapping two chunks of different random sizes (1 byte to 64 KiB) at random offsets of a 2 GiB pattern changes its digest, in each of 100 trials", () => {
    let state = 0x9e3779b9;
    const random = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
    const whole = patternDigest(2 * GIB, 21);
    const unchanged: string[] = [];

    for (let trial = 0; trial < 100; trial += 1) {
      const firstSize = between(1, 64 * KIB);
      let secondSize = between(1, 64 * KIB);
      if (secondSize === firstSize) secondSize = firstSize === 1 ? 2 : firstSize - 1;
      const first = between(0, GIB - firstSize);
      const second = between(GIB, 2 * GIB - secondSize);
      const swapped = patternDigestSwapped(2 * GIB, 21, { first, firstSize, second, secondSize });
      if (swapped === whole)
        unchanged.push(`trial ${String(trial)} at ${String(first)}/${String(second)}`);
    }

    expect(unchanged).toEqual([]);
  }, 300_000);
});
