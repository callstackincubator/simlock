import { createHmac } from "node:crypto";
import { createServer } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventBus, type EventMap, type EventName } from "../bus/index.js";
import { type AlertDestination } from "../core/index.js";
import { FakeClock, FetchWebhookPoster, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import { FakeWebhookPoster } from "../ports/testing.js";
import { createAlerts, type Alerts } from "./index.js";
import { ALERT_FORMAT_REGISTRY } from "./formats/index.js";

const URL_TOKEN = "hook-token-xyz";

function destination(overrides: Partial<AlertDestination> = {}): AlertDestination {
  return {
    name: "audit",
    format: "generic",
    url: `https://n8n.example.com/${URL_TOKEN}`,
    events: ["worker.connected"],
    secret: "s3cr3t",
    ...overrides,
  };
}

function slackDestination(overrides: Partial<AlertDestination> = {}): AlertDestination {
  const { secret: _secret, ...rest } = destination({ format: "slack", ...overrides });
  return rest;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const connected = (workerId = "wrk_1") => ({ workerId });

class Harness {
  readonly clock = new FakeClock(1_000);
  readonly eventBus = new EventBus(this.clock);
  readonly poster = new FakeWebhookPoster();
  readonly sink = new MemoryLogSink();
  readonly labels = new Map<string, string>();
  alerts: Alerts;

  constructor(destinations: AlertDestination[] = [destination()]) {
    this.alerts = createAlerts({
      destinations,
      eventBus: this.eventBus,
      poster: this.poster,
      clock: this.clock,
      logger: new JsonLinesLogger({ clock: this.clock, level: "debug", sink: this.sink }).child(
        "alerts",
      ),
      version: "9.9.9",
      workerLabel: (id) => this.labels.get(id),
    });
  }

  emit<Event extends EventName>(event: Event, payload: EventMap[Event]) {
    return this.eventBus.emit(event, payload, "test");
  }

  logs(message: string) {
    return this.sink.records.filter((record) => record.message === message);
  }

  async advance(milliseconds: number): Promise<void> {
    this.clock.advance(milliseconds);
    await settle();
  }

  failWith(kind: "refused" | "no-code" | 429 | 500 | 503): void {
    this.poster.respond = () => {
      if (kind === "refused") {
        return Promise.reject(
          Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
        );
      }
      if (kind === "no-code") return Promise.reject(new TypeError("fetch failed"));
      return Promise.resolve({ status: kind });
    };
  }
}

function deferred() {
  let resolve!: (value: { status: number }) => void;
  const promise = new Promise<{ status: number }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const harnesses: Harness[] = [];
function harness(destinations?: AlertDestination[]): Harness {
  const created = new Harness(destinations);
  harnesses.push(created);
  return created;
}
afterEach(() => {
  for (const each of harnesses.splice(0)) each.alerts.stop();
  vi.restoreAllMocks();
});

describe("alerts", () => {
  const gatewayOwn = (h: Harness) => h.emit("worker.connected", connected());
  const relayed = (h: Harness) =>
    h.eventBus.republish({
      id: "evt_remote",
      timestamp: 42,
      event: "device.quarantine-abandoned",
      payload: { deviceId: "dev_1", attempts: 3, workerId: "wrk_9" } as never,
      module: "quarantine",
    });

  it.each([
    ["a gateway-own worker.connected", gatewayOwn, "wrk_1"],
    ["a republished device.quarantine-abandoned", relayed, "wrk_9"],
  ])(
    "posts a listed event to a generic destination as the envelope with Content-Type, User-Agent, X-Simlock-Event, X-Simlock-Delivery and a signature that verifies with the secret, and logs Alert delivered at debug (%s)",
    async (_name, emitEnvelope, workerId) => {
      const h = harness([
        destination({ events: ["worker.connected", "device.quarantine-abandoned"] }),
      ]);
      const envelope = emitEnvelope(h);
      await settle();

      expect(h.poster.requests).toHaveLength(1);
      const [request] = h.poster.requests;
      expect(request?.url).toBe(destination().url);
      expect(request?.body).toBe(JSON.stringify(envelope));
      expect(JSON.parse(request?.body ?? "").payload.workerId).toBe(workerId);
      expect(request?.headers).toEqual({
        "Content-Type": "application/json",
        "User-Agent": "simlock/9.9.9",
        "X-Simlock-Event": envelope.event,
        "X-Simlock-Delivery": envelope.id,
        "X-Simlock-Signature": `sha256=${createHmac("sha256", "s3cr3t")
          .update(request?.body ?? "")
          .digest("hex")}`,
      });
      expect(h.logs("Alert delivered")).toHaveLength(1);
      expect(h.logs("Alert delivered")[0]?.level).toBe("debug");
    },
  );

  it('a slack destination posts {"text": message} with only the Content-Type and User-Agent headers', async () => {
    const h = harness([slackDestination()]);
    h.emit("worker.connected", connected("wrk_1"));
    await settle();

    expect(h.poster.requests).toHaveLength(1);
    expect(h.poster.requests[0]?.headers).toEqual({
      "Content-Type": "application/json",
      "User-Agent": "simlock/9.9.9",
    });
    expect(JSON.parse(h.poster.requests[0]?.body ?? "")).toEqual({
      text: "🟢 Worker wrk_1 connected.",
    });
  });

  it("each of the eleven events posts its message word for word", async () => {
    const rows: [EventName, Record<string, unknown>, string][] = [
      [
        "worker.connected",
        { workerId: "wrk_1", version: "1.2.3" },
        "🟢 Worker wrk_1 connected (simlock 1.2.3).",
      ],
      ["worker.connected", { workerId: "wrk_1" }, "🟢 Worker wrk_1 connected."],
      [
        "worker.disconnected",
        { workerId: "wrk_1", leaseCount: 0 },
        "🔴 Worker wrk_1 disconnected.",
      ],
      [
        "worker.disconnected",
        { workerId: "wrk_1", leaseCount: 1 },
        "🔴 Worker wrk_1 disconnected while holding 1 lease.",
      ],
      [
        "worker.disconnected",
        { workerId: "wrk_1", leaseCount: 3 },
        "🔴 Worker wrk_1 disconnected while holding 3 leases.",
      ],
      [
        "worker.rejected",
        { reason: "forbidden", workerId: "wrk_x" },
        "⛔ A worker was refused (forbidden): wrk_x.",
      ],
      [
        "worker.drain-started",
        { workerId: "wrk_1" },
        "⏸ Worker wrk_1 is drained: it takes no new leases.",
      ],
      ["worker.drain-ended", { workerId: "wrk_1" }, "▶️ Worker wrk_1 takes new leases again."],
      [
        "device.quarantine-abandoned",
        { workerId: "wrk_1", deviceId: "dev_1", attempts: 3 },
        "⚠️ Device dev_1 on wrk_1 was retired after 3 failed clean-ups.",
      ],
      [
        "device.quarantine-stranded",
        { workerId: "wrk_1", deviceId: "dev_1", attempts: 4, error: "disk full" },
        "🛑 Device dev_1 on wrk_1 could not be cleaned up or deleted after 4 tries: disk full. It needs a person.",
      ],
      [
        "device.recovery-failed",
        { workerId: "wrk_1", deviceId: "dev_1", leaseId: "lse_1", reason: "boot-timeout" },
        "⚠️ Device dev_1 on wrk_1 crashed during lease lse_1 and could not be brought back: boot-timeout.",
      ],
      [
        "device.stalled-transition-detected",
        { workerId: "wrk_1", deviceId: "dev_1", state: "booting", ageMs: 840_000 },
        "⏳ Device dev_1 on wrk_1 has been booting for 14 min.",
      ],
      [
        "disk.pressure-detected",
        { workerId: "wrk_1", freeBytes: 8_804_682_956, threshold: 10_737_418_240 },
        "💾 Worker wrk_1 is low on disk: 8.2 GiB free (threshold 10 GiB).",
      ],
      [
        "component.install-failed",
        { workerId: "wrk_1", platform: "ios", componentId: "runtime-18", error: "no space" },
        "❌ Installing ios runtime-18 on wrk_1 failed: no space.",
      ],
    ];
    const events = [...new Set(rows.map(([event]) => event))] as AlertDestination["events"];
    const h = harness([slackDestination({ events })]);
    for (const [event, payload] of rows) {
      h.emit(event, payload as never);
      await settle();
    }

    expect(h.poster.requests.map((request) => JSON.parse(request.body).text)).toEqual(
      rows.map(([, , text]) => text),
    );
  });

  it("names the worker by the label workerLabel answers, and by the id when it answers undefined", async () => {
    const h = harness([slackDestination({ events: ["worker.drain-started"] })]);
    h.labels.set("wrk_1", "build-mac-3");
    h.emit("worker.drain-started", { workerId: "wrk_1" });
    h.emit("worker.drain-started", { workerId: "wrk_2" });
    await settle();
    await h.advance(1_000);

    expect(h.poster.requests.map((request) => JSON.parse(request.body).text)).toEqual([
      "⏸ Worker build-mac-3 is drained: it takes no new leases.",
      "⏸ Worker wrk_2 is drained: it takes no new leases.",
    ]);
  });

  it("builds a message when it leaves the queue and resends the same body on later tries", async () => {
    const h = harness([slackDestination({ events: ["worker.drain-started"] })]);
    const first = deferred();
    h.poster.respond = (_request, index) =>
      index === 0 ? first.promise : Promise.resolve({ status: 503 });
    h.labels.set("wrk_1", "old-name");
    h.emit("worker.drain-started", { workerId: "wrk_0" });
    await settle();
    h.emit("worker.drain-started", { workerId: "wrk_1" });
    h.labels.set("wrk_1", "new-name");
    first.resolve({ status: 200 });
    await settle();
    h.labels.set("wrk_1", "newer-name");
    await h.advance(1_000);

    const texts = h.poster.requests.slice(1).map((request) => JSON.parse(request.body).text);
    expect(texts).toEqual([
      "⏸ Worker new-name is drained: it takes no new leases.",
      "⏸ Worker new-name is drained: it takes no new leases.",
    ]);
  });

  it("worker.rejected names the claimed label, else the claimed id, else an unknown worker, and adds the count only above one", async () => {
    const h = harness([slackDestination({ events: ["worker.rejected"] })]);
    h.labels.set("wrk_9", "registry-name");
    const cases: [Record<string, unknown>, string][] = [
      [{ reason: "forbidden", workerId: "wrk_9", label: "claimed-label" }, "claimed-label."],
      [{ reason: "forbidden", workerId: "wrk_9" }, "wrk_9."],
      [{ reason: "unauthenticated" }, "an unknown worker."],
      [{ reason: "forbidden", workerId: "wrk_9", count: 1 }, "wrk_9."],
      [
        { reason: "forbidden", workerId: "wrk_9", count: 4 },
        "wrk_9. 4 more refusals like it came before this one.",
      ],
    ];
    for (const [payload] of cases) {
      h.emit("worker.rejected", payload as never);
      await settle();
    }

    expect(h.poster.requests.map((request) => JSON.parse(request.body).text)).toEqual(
      cases.map(([payload, tail]) => `⛔ A worker was refused (${payload.reason}): ${tail}`),
    );
  });

  it("formats an age in seconds, minutes, and hours with minutes", async () => {
    const h = harness([slackDestination({ events: ["device.stalled-transition-detected"] })]);
    const cases: [number, string][] = [
      [45_000, "45 s"],
      [840_000, "14 min"],
      [3_900_000, "1 h 5 min"],
      [7_200_000, "2 h"],
      [59_999, "59 s"],
      [60_000, "1 min"],
      [3_600_000, "1 h"],
    ];
    for (const [ageMs] of cases) {
      h.emit("device.stalled-transition-detected", {
        workerId: "wrk_1",
        deviceId: "dev_1",
        state: "booting",
        ageMs,
      } as never);
      await settle();
    }

    expect(h.poster.requests.map((request) => JSON.parse(request.body).text)).toEqual(
      cases.map(([, age]) => `⏳ Device dev_1 on wrk_1 has been booting for ${age}.`),
    );
  });

  it("formats bytes in GiB and MiB with one decimal rounded half up, dropping .0", async () => {
    const h = harness([slackDestination({ events: ["disk.pressure-detected"] })]);
    const cases: [number, string][] = [
      [8_804_682_956, "8.2 GiB"],
      [10_737_418_240, "10 GiB"],
      [536_870_912, "512 MiB"],
      [1_020_054_733, "972.8 MiB"],
      [1_073_741_824, "1 GiB"],
    ];
    for (const [freeBytes] of cases) {
      h.emit("disk.pressure-detected", {
        workerId: "wrk_1",
        freeBytes,
        threshold: 10_737_418_240,
      } as never);
      await settle();
    }

    expect(h.poster.requests.map((request) => JSON.parse(request.body).text)).toEqual(
      cases.map(([, size]) => `💾 Worker wrk_1 is low on disk: ${size} free (threshold 10 GiB).`),
    );
  });

  it("cuts every variable part to 300 code points, then escapes &, < and >", async () => {
    const h = harness([
      slackDestination({
        events: [
          "component.install-failed",
          "worker.drain-started",
          "worker.rejected",
          "device.quarantine-abandoned",
          "device.stalled-transition-detected",
        ],
      }),
    ]);
    h.labels.set("wrk_1", "<!channel>");
    h.labels.set("wrk_2", `${"a".repeat(299)}😀b`);
    const install = (error: string) =>
      [
        "component.install-failed",
        { workerId: "wrk_0", platform: "ios", componentId: "c", error },
      ] as const;
    const cases: [readonly [EventName, Record<string, unknown>], string][] = [
      [install("<b>&"), "❌ Installing ios c on wrk_0 failed: &lt;b&gt;&amp;."],
      [
        ["worker.drain-started", { workerId: "wrk_1" }],
        "⏸ Worker &lt;!channel&gt; is drained: it takes no new leases.",
      ],
      [
        ["worker.rejected", { reason: "forbidden", label: "<!here>" }],
        "⛔ A worker was refused (forbidden): &lt;!here&gt;.",
      ],
      [
        ["worker.rejected", { reason: "<r>", label: "x" }],
        "⛔ A worker was refused (&lt;r&gt;): x.",
      ],
      [
        [
          "device.stalled-transition-detected",
          { workerId: "wrk_0", deviceId: "d", state: "<s>", ageMs: 1000 },
        ],
        "⏳ Device d on wrk_0 has been &lt;s&gt; for 1 s.",
      ],
      [
        ["device.quarantine-abandoned", { workerId: "wrk_0", deviceId: "d", attempts: "<a>" }],
        "⚠️ Device d on wrk_0 was retired after &lt;a&gt; failed clean-ups.",
      ],
      [
        install(`${"e".repeat(299)}&b`),
        `❌ Installing ios c on wrk_0 failed: ${"e".repeat(299)}&amp;….`,
      ],
      [
        install(`${"e".repeat(299)}<b`),
        `❌ Installing ios c on wrk_0 failed: ${"e".repeat(299)}&lt;….`,
      ],
      [install("e".repeat(301)), `❌ Installing ios c on wrk_0 failed: ${"e".repeat(300)}….`],
      [install("e".repeat(300)), `❌ Installing ios c on wrk_0 failed: ${"e".repeat(300)}.`],
      [
        ["worker.drain-started", { workerId: "wrk_2" }],
        `⏸ Worker ${"a".repeat(299)}😀… is drained: it takes no new leases.`,
      ],
    ];
    for (const [[event, payload]] of cases) {
      h.emit(event, payload as never);
      await settle();
    }

    expect(h.poster.requests.map((request) => JSON.parse(request.body).text)).toEqual(
      cases.map(([, text]) => text),
    );
  });

  it("escapes every variable part of every message that carries one", async () => {
    const x = "<x>";
    const h = harness([
      slackDestination({
        events: [
          "worker.connected",
          "worker.disconnected",
          "worker.rejected",
          "device.quarantine-abandoned",
          "device.quarantine-stranded",
          "device.recovery-failed",
          "device.stalled-transition-detected",
          "component.install-failed",
        ],
      }),
    ]);
    const w = { workerId: "wrk_0" };
    const cases: [EventName, Record<string, unknown>, string][] = [
      ["worker.connected", { ...w, version: x }, "🟢 Worker wrk_0 connected (simlock &lt;x&gt;)."],
      [
        "worker.disconnected",
        { ...w, leaseCount: x },
        "🔴 Worker wrk_0 disconnected while holding &lt;x&gt; leases.",
      ],
      [
        "worker.rejected",
        { reason: x, workerId: x },
        "⛔ A worker was refused (&lt;x&gt;): &lt;x&gt;.",
      ],
      [
        "device.quarantine-abandoned",
        { ...w, deviceId: x, attempts: x },
        "⚠️ Device &lt;x&gt; on wrk_0 was retired after &lt;x&gt; failed clean-ups.",
      ],
      [
        "device.quarantine-stranded",
        { ...w, deviceId: x, attempts: x, error: x },
        "🛑 Device &lt;x&gt; on wrk_0 could not be cleaned up or deleted after &lt;x&gt; tries: &lt;x&gt;. It needs a person.",
      ],
      [
        "device.recovery-failed",
        { ...w, deviceId: x, leaseId: x, reason: x },
        "⚠️ Device &lt;x&gt; on wrk_0 crashed during lease &lt;x&gt; and could not be brought back: &lt;x&gt;.",
      ],
      [
        "device.stalled-transition-detected",
        { ...w, deviceId: x, state: x, ageMs: 1000 },
        "⏳ Device &lt;x&gt; on wrk_0 has been &lt;x&gt; for 1 s.",
      ],
      [
        "component.install-failed",
        { ...w, platform: x, componentId: x, error: x },
        "❌ Installing &lt;x&gt; &lt;x&gt; on wrk_0 failed: &lt;x&gt;.",
      ],
    ];
    for (const [event, payload] of cases) {
      h.emit(event, payload as never);
      await settle();
    }

    expect(h.poster.requests.map((request) => JSON.parse(request.body).text)).toEqual(
      cases.map(([, , text]) => text),
    );
  });

  it("a relayed payload with missing fields posts the text the Known gap names", async () => {
    const h = harness([
      slackDestination({
        events: [
          "device.quarantine-abandoned",
          "disk.pressure-detected",
          "device.stalled-transition-detected",
        ],
      }),
    ]);
    const cases: [EventName, Record<string, unknown>, string][] = [
      [
        "device.quarantine-abandoned",
        { workerId: "wrk_1", deviceId: "dev_1" },
        "⚠️ Device dev_1 on wrk_1 was retired after undefined failed clean-ups.",
      ],
      [
        "disk.pressure-detected",
        { workerId: "wrk_1", threshold: 10_737_418_240 },
        "💾 Worker wrk_1 is low on disk: ? free (threshold 10 GiB).",
      ],
      [
        "device.stalled-transition-detected",
        { workerId: "wrk_1" },
        "⏳ Device undefined on wrk_1 has been undefined for ?.",
      ],
    ];
    for (const [event, payload] of cases) {
      h.emit(event, payload as never);
      await settle();
    }

    expect(h.poster.requests.map((request) => JSON.parse(request.body).text)).toEqual(
      cases.map(([, , text]) => text),
    );
  });

  it("a slack destination is tried again on 5xx like a generic one", async () => {
    const h = harness([slackDestination()]);
    h.failWith(503);
    h.emit("worker.connected", connected());
    await settle();
    await h.advance(1_000);

    expect(h.poster.requests).toHaveLength(2);
    expect(h.poster.requests[1]?.body).toBe(h.poster.requests[0]?.body);
  });

  it("posts nothing for an event the destination did not list", async () => {
    const h = harness();
    h.emit("worker.connected", connected());
    await settle();
    expect(h.poster.requests).toHaveLength(1);

    h.emit("worker.disconnected", { workerId: "wrk_1", leaseCount: 0 });
    h.emit("lease.granted", {
      leaseId: "lse_1",
      deviceId: "dev_1",
      requester: "r",
      requestId: "req_1",
      source: "warm",
    } as never);
    await h.advance(60_000);

    expect(h.poster.requests).toHaveLength(1);
  });

  it("posts to every destination that lists the event, each signed with its own secret", async () => {
    const h = harness([
      destination({ name: "one", url: "https://one.example.com/x", secret: "first" }),
      destination({ name: "two", url: "https://two.example.com/x", secret: "second" }),
      destination({
        name: "other",
        url: "https://other.example.com/x",
        events: ["worker.disconnected"],
      }),
    ]);
    h.emit("worker.connected", connected());
    await settle();

    const byUrl = new Map(h.poster.requests.map((request) => [request.url, request]));
    expect([...byUrl.keys()].sort()).toEqual([
      "https://one.example.com/x",
      "https://two.example.com/x",
    ]);
    for (const [url, secret] of [
      ["https://one.example.com/x", "first"],
      ["https://two.example.com/x", "second"],
    ] as const) {
      const request = byUrl.get(url);
      expect(request?.headers["X-Simlock-Signature"]).toBe(
        `sha256=${createHmac("sha256", secret)
          .update(request?.body ?? "")
          .digest("hex")}`,
      );
    }
  });

  describe("a failed try", () => {
    const cases = [
      { name: "a network error", kind: "refused", endMs: 0, field: { error: "ECONNREFUSED" } },
      {
        name: "an error without a code",
        kind: "no-code",
        endMs: 0,
        field: { error: "network-error" },
      },
      { name: "429", kind: 429, endMs: 0, field: { status: 429 } },
      { name: "500", kind: 500, endMs: 0, field: { status: 500 } },
      { name: "5xx", kind: 503, endMs: 0, field: { status: 503 } },
      { name: "a timeout", kind: "timeout", endMs: 10_000, field: { error: "timeout" } },
    ] as const;

    it.each(cases)(
      "tries again after $name, 1 s then 5 s after the failed try, and gives up with a warn line after the third",
      async ({ kind, endMs, field }) => {
        const h = harness();
        if (kind === "timeout") h.poster.respond = () => new Promise(() => {});
        else h.failWith(kind);
        const envelope = h.emit("worker.connected", connected());
        await settle();
        expect(h.poster.requests).toHaveLength(1);

        await h.advance(endMs + 999);
        expect(h.poster.requests).toHaveLength(1);
        await h.advance(1);
        expect(h.poster.requests).toHaveLength(2);

        await h.advance(endMs + 4_999);
        expect(h.poster.requests).toHaveLength(2);
        expect(h.logs("Alert send gave up")).toHaveLength(0);
        await h.advance(1);
        expect(h.poster.requests).toHaveLength(3);

        await h.advance(endMs);
        expect(h.logs("Alert send gave up")).toHaveLength(1);
        const [line] = h.logs("Alert send gave up");
        expect(line?.level).toBe("warn");
        expect(line?.fields).toEqual({
          destination: "audit",
          event: "worker.connected",
          eventId: envelope.id,
          attempt: 3,
          ...field,
        });
        await h.advance(60_000);
        expect(h.poster.requests).toHaveLength(3);
      },
    );
  });

  it.each([301, 400, 404])(
    "gives up at once on a status that is not 2xx, 429 or 5xx, and posts it once (%i)",
    async (status) => {
      const h = harness();
      h.poster.respond = () => Promise.resolve({ status });
      h.emit("worker.connected", connected());
      await settle();

      expect(h.logs("Alert send gave up").map((line) => line.fields)).toEqual([
        expect.objectContaining({ attempt: 1, status }),
      ]);
      await h.advance(60_000);
      expect(h.poster.requests).toHaveLength(1);
    },
  );

  it("aborts a try with no answer at 10 s, not before, and moves on without waiting for it to settle", async () => {
    const h = harness();
    const first = deferred();
    h.poster.respond = (_request, index) => (index === 0 ? first.promise : new Promise(() => {}));
    h.emit("worker.connected", connected());
    await settle();
    const signal = h.poster.requests[0]?.signal;

    await h.advance(9_999);
    expect(signal?.aborted).toBe(false);
    await h.advance(1);
    expect(signal?.aborted).toBe(true);

    await h.advance(1_000);
    expect(h.poster.requests).toHaveLength(2);
    first.resolve({ status: 200 });
    await settle();
    expect(h.logs("Alert delivered")).toHaveLength(0);
    expect(h.poster.requests).toHaveLength(2);
  });

  it("sends one message at a time per destination, in the order the bus emitted them, the second only after the first's last try", async () => {
    const h = harness();
    h.failWith(503);
    const a = h.emit("worker.connected", connected("wrk_a"));
    const b = h.emit("worker.connected", connected("wrk_b"));
    const c = h.emit("worker.connected", connected("wrk_c"));
    await settle();
    await h.advance(1_000);
    await h.advance(4_999);
    const sent = () => h.poster.requests.map((request) => request.headers["X-Simlock-Delivery"]);
    expect(sent()).toEqual([a.id, a.id]);

    await h.advance(1);
    expect(sent()).toEqual([a.id, a.id, a.id, b.id]);

    h.poster.respond = () => Promise.resolve({ status: 200 });
    await h.advance(1_000);
    expect(sent()).toEqual([a.id, a.id, a.id, b.id, b.id, c.id]);
  });

  it("a destination that does not answer does not delay another", async () => {
    const h = harness([
      destination({ name: "stuck", url: "https://stuck.example.com/x" }),
      destination({ name: "quick", url: "https://quick.example.com/x" }),
    ]);
    h.poster.respond = (request) =>
      request.url.includes("stuck") ? new Promise(() => {}) : Promise.resolve({ status: 200 });
    h.emit("worker.connected", connected("wrk_a"));
    h.emit("worker.connected", connected("wrk_b"));
    await settle();

    const quick = h.poster.requests.filter((request) => request.url.includes("quick"));
    expect(quick).toHaveLength(2);
    expect(h.poster.requests.filter((request) => request.url.includes("stuck"))).toHaveLength(1);
  });

  it("keeps at most 100 waiting per destination and drops the oldest waiting one, never the one in flight, with a warn line", async () => {
    const h = harness();
    const inFlight = deferred();
    h.poster.respond = (_request, index) =>
      index === 0 ? inFlight.promise : Promise.resolve({ status: 200 });
    const envelopes = [h.emit("worker.connected", connected("wrk_0"))];
    await settle();
    for (let index = 1; index <= 100; index += 1) {
      envelopes.push(h.emit("worker.connected", connected(`wrk_${index}`)));
    }
    expect(h.logs("Alert dropped: queue full")).toHaveLength(0);
    envelopes.push(h.emit("worker.connected", connected("wrk_101")));

    const dropped = h.logs("Alert dropped: queue full");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.level).toBe("warn");
    expect(dropped[0]?.fields).toMatchObject({ destination: "audit", eventId: envelopes[1]?.id });

    inFlight.resolve({ status: 200 });
    await settle();
    const sent = h.poster.requests.map((request) => request.headers["X-Simlock-Delivery"]);
    expect(sent).toEqual(
      envelopes.filter((_envelope, index) => index !== 1).map((each) => each.id),
    );
  });

  it("stop aborts the try in flight, posts nothing more, ignores later events and late settles, and logs the discarded count per destination as its last line", async () => {
    const h = harness();
    const inFlight = deferred();
    h.poster.respond = () => inFlight.promise;
    h.emit("worker.connected", connected("wrk_a"));
    await settle();
    h.emit("worker.connected", connected("wrk_b"));
    h.emit("worker.connected", connected("wrk_c"));

    h.alerts.stop();
    expect(h.poster.requests[0]?.signal.aborted).toBe(true);
    const lines = h.sink.records.length;
    expect(h.sink.records.at(-1)).toMatchObject({
      level: "info",
      message: "Alerts discarded at stop",
      fields: { discarded: { audit: 3 } },
    });

    h.emit("worker.connected", connected("wrk_d"));
    inFlight.resolve({ status: 200 });
    await h.advance(60_000);
    expect(h.poster.requests).toHaveLength(1);
    expect(h.sink.records).toHaveLength(lines);

    const same = harness();
    same.emit("worker.connected", connected("wrk_e"));
    same.alerts.stop();
    await same.advance(60_000);
    expect(same.poster.requests).toHaveLength(0);
  });

  it("stop counts a message waiting between tries as discarded and cancels its retry", async () => {
    const h = harness();
    h.failWith(503);
    h.emit("worker.connected", connected());
    await settle();

    h.alerts.stop();
    await h.advance(60_000);

    expect(h.logs("Alerts discarded at stop")[0]?.fields).toEqual({ discarded: { audit: 1 } });
    expect(h.poster.requests).toHaveLength(1);
  });

  it("the bus handler returns before the post settles, and a poster that throws reaches neither the emitter nor other subscribers", async () => {
    const h = harness();
    const seen: string[] = [];
    h.eventBus.subscribe("worker.connected", (envelope) => seen.push(envelope.id));
    const first = h.emit("worker.connected", connected("wrk_a"));
    expect(h.poster.requests).toHaveLength(0);
    await settle();
    expect(h.poster.requests).toHaveLength(1);
    expect(seen).toEqual([first.id]);

    h.poster.post = () => {
      throw new Error(`boom ${URL_TOKEN}`);
    };
    const envelope = h.emit("worker.connected", connected());
    expect(seen).toEqual([first.id, envelope.id]);
    await settle();
    await h.advance(1_000);
    await h.advance(5_000);
    expect(h.logs("Alert send gave up")[0]?.fields).toMatchObject({
      attempt: 3,
      error: "network-error",
    });
  });

  it("a request that throws while being built ends as gave up with build-failed and the next message is sent", async () => {
    const h = harness();
    const original = ALERT_FORMAT_REGISTRY.generic.build;
    vi.spyOn(ALERT_FORMAT_REGISTRY.generic, "build").mockImplementationOnce(() => {
      throw new Error(`cannot build ${URL_TOKEN}`);
    });
    vi.spyOn(ALERT_FORMAT_REGISTRY.generic, "build").mockImplementation(original);
    const first = h.emit("worker.connected", connected("wrk_a"));
    const second = h.emit("worker.connected", connected("wrk_b"));
    await settle();

    expect(h.logs("Alert send gave up")[0]?.fields).toMatchObject({
      eventId: first.id,
      error: "build-failed",
    });
    expect(h.poster.requests.map((request) => request.headers["X-Simlock-Delivery"])).toEqual([
      second.id,
    ]);
  });

  it("a message is built once when it leaves the queue, and later tries resend the same headers and body", async () => {
    const h = harness();
    let calls = 0;
    const build = vi.spyOn(ALERT_FORMAT_REGISTRY.generic, "build").mockImplementation(() => {
      calls += 1;
      return { headers: { "X-Call": String(calls) }, body: `call-${calls}` };
    });
    h.failWith(503);
    h.emit("worker.connected", connected());
    await settle();
    await h.advance(1_000);
    await h.advance(5_000);

    expect(h.poster.requests).toHaveLength(3);
    for (const request of h.poster.requests) {
      expect(request.headers).toEqual({ "X-Call": "1" });
      expect(request.body).toBe("call-1");
    }
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("no log line holds a destination's url or secret", async () => {
    const h = harness([destination({ events: ["worker.connected", "worker.disconnected"] })]);
    h.poster.respond = () =>
      Promise.reject(
        Object.assign(new TypeError(`fetch failed: ${destination().url} s3cr3t`), {
          cause: { code: "ECONNREFUSED" },
        }),
      );
    h.emit("worker.connected", connected());
    await settle();
    await h.advance(1_000);
    await h.advance(5_000);
    h.poster.respond = () => Promise.resolve({ status: 200 });
    h.emit("worker.connected", connected());
    await settle();
    vi.spyOn(ALERT_FORMAT_REGISTRY.generic, "build").mockImplementationOnce(() => {
      throw new Error(`cannot build ${destination().url} s3cr3t`);
    });
    h.emit("worker.connected", connected());
    await settle();
    h.poster.respond = () => new Promise(() => {});
    for (let index = 0; index < 102; index += 1) {
      h.emit("worker.disconnected", { workerId: `wrk_${index}`, leaseCount: 0 });
    }
    h.alerts.stop();

    const text = h.sink.records.map((record) => JSON.stringify(record)).join("\n");
    expect(h.logs("Alert delivered")).toHaveLength(1);
    expect(h.logs("Alert send gave up")).toHaveLength(2);
    expect(h.logs("Alert dropped: queue full")).toHaveLength(1);
    expect(h.logs("Alerts discarded at stop")).toHaveLength(1);
    expect(text).not.toContain(URL_TOKEN);
    expect(text).not.toContain("n8n.example.com");
    expect(text).not.toContain("s3cr3t");
  });

  it("a refused connection through FetchWebhookPoster logs ECONNREFUSED and never the URL", async () => {
    const closedPort = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        server.close(() => resolve(port));
      });
    });
    const h = harness([]);
    const alerts = createAlerts({
      destinations: [destination({ url: `http://127.0.0.1:${closedPort}/${URL_TOKEN}` })],
      eventBus: h.eventBus,
      poster: new FetchWebhookPoster(),
      clock: h.clock,
      logger: new JsonLinesLogger({ clock: h.clock, level: "debug", sink: h.sink }),
      version: "9.9.9",
      workerLabel: () => undefined,
    });
    h.emit("worker.connected", connected());

    await vi.waitFor(
      () => {
        h.clock.advance(10_000);
        expect(h.logs("Alert send gave up")).toHaveLength(1);
      },
      { timeout: 5_000, interval: 50 },
    );
    alerts.stop();

    expect(h.logs("Alert send gave up")[0]?.fields).toMatchObject({ error: "ECONNREFUSED" });
    expect(JSON.stringify(h.sink.records)).not.toContain(URL_TOKEN);
    expect(JSON.stringify(h.sink.records)).not.toContain(String(closedPort));
  });
});
