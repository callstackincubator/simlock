import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { type AlertDestination } from "../core/index.js";
import { FetchWebhookPoster, type WebhookPoster } from "../ports/index.js";
import { ScriptedWorkerClient } from "./test-support.js";
import { harness, session } from "./test-dispatcher.js";

type SentRequest = Parameters<WebhookPoster["post"]>[0];

describe("GatewayDispatcher", () => {
  describe("alerts.test", () => {
    const generic: AlertDestination = {
      name: "ops",
      format: "generic",
      url: "https://hooks.example.com/ops-token",
      events: ["worker.connected"],
      secret: "s3cr3t",
    };
    const slack: AlertDestination = {
      name: "chat",
      format: "slack",
      url: "https://hooks.slack.example.com/chat-token",
      events: ["worker.connected"],
    };

    it("alerts.test posts one sample to the named destination and answers its status", async () => {
      const { dispatcher, poster } = harness({ alertDestinations: [generic, slack] });

      await expect(
        dispatcher.dispatch("alerts.test", { destination: "ops" }, session()),
      ).resolves.toEqual({ destination: "ops", status: 200 });
      await expect(
        dispatcher.dispatch("alerts.test", { destination: "chat" }, session()),
      ).resolves.toEqual({ destination: "chat", status: 200 });

      expect(poster.requests).toHaveLength(2);
      const [first, second] = poster.requests as [SentRequest, SentRequest];
      expect(first.url).toBe("https://hooks.example.com/ops-token");
      expect(JSON.parse(first.body)).toEqual({
        id: "evt_sample-id",
        seq: 0,
        timestamp: 1_000,
        event: "alerts.test-sent",
        payload: { destination: "ops" },
        module: "alerts",
      });
      expect(first.headers).toEqual({
        "Content-Type": "application/json",
        "User-Agent": "simlock/9.9.9",
        "X-Simlock-Event": "alerts.test-sent",
        "X-Simlock-Delivery": "evt_sample-id",
        "X-Simlock-Signature": `sha256=${createHmac("sha256", "s3cr3t")
          .update(first.body)
          .digest("hex")}`,
      });
      expect(second.url).toBe("https://hooks.slack.example.com/chat-token");
      expect(JSON.parse(second.body)).toEqual({
        text: "🔔 Test message from the simlock gateway to destination chat.",
      });
      expect(second.headers).toEqual({
        "Content-Type": "application/json",
        "User-Agent": "simlock/9.9.9",
      });

      const other = harness({ alertDestinations: [generic] });
      other.poster.respond = () => Promise.resolve({ status: 204 });
      await expect(
        other.dispatcher.dispatch("alerts.test", { destination: "ops" }, session()),
      ).resolves.toEqual({ destination: "ops", status: 204 });
    });

    it("alerts.test fails with ALERT_SEND_FAILED on a non-2xx status, a rejection and no answer within 10 s, and tries once", async () => {
      const refused = Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      });
      const cases = [
        [() => Promise.resolve({ status: 404 }), "ops answered HTTP 404", { status: 404 }],
        [() => Promise.resolve({ status: 199 }), "ops answered HTTP 199", { status: 199 }],
        [() => Promise.resolve({ status: 301 }), "ops answered HTTP 301", { status: 301 }],
        [() => Promise.resolve({ status: 503 }), "ops answered HTTP 503", { status: 503 }],
        [
          () => Promise.reject(refused),
          "ops could not be reached: ECONNREFUSED",
          { error: "ECONNREFUSED" },
        ],
        [
          () => Promise.reject(new TypeError("fetch failed")),
          "ops could not be reached: network-error",
          { error: "network-error" },
        ],
      ] as const;
      for (const [respond, message, details] of cases) {
        const { clock, dispatcher, poster } = harness({ alertDestinations: [generic] });
        poster.respond = respond;

        await expect(
          dispatcher.dispatch("alerts.test", { destination: "ops" }, session()),
        ).rejects.toMatchObject({
          code: "ALERT_SEND_FAILED",
          message,
          details: { destination: "ops", ...details },
        });
        clock.advance(60_000);
        expect(poster.requests).toHaveLength(1);
      }

      const { clock, dispatcher, poster } = harness({ alertDestinations: [generic] });
      poster.respond = () => new Promise(() => {});
      let outcome: unknown = "pending";
      void dispatcher.dispatch("alerts.test", { destination: "ops" }, session()).then(
        (value) => (outcome = value),
        (error: unknown) => (outcome = error),
      );
      await vi.waitFor(() => expect(poster.requests).toHaveLength(1));
      clock.advance(9_999);
      await new Promise((resolve) => setImmediate(resolve));
      expect(outcome).toBe("pending");
      expect(poster.requests[0]?.signal.aborted).toBe(false);

      clock.advance(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(outcome).toMatchObject({
        code: "ALERT_SEND_FAILED",
        message: "ops did not answer within 10 s",
        details: { destination: "ops", error: "timeout" },
      });
      expect(poster.requests[0]?.signal.aborted).toBe(true);
      clock.advance(60_000);
      expect(poster.requests).toHaveLength(1);
    });

    it("alerts.test answers UNKNOWN_ALERT_DESTINATION for a name not configured and on a gateway with no destinations", async () => {
      const unknown = {
        code: "UNKNOWN_ALERT_DESTINATION",
        message:
          'No alert destination named "nope". Check gateway.alerts.destinations in the gateway\'s config.',
        details: { destination: "nope" },
      };
      const configured = harness({ alertDestinations: [generic] });
      await expect(
        configured.dispatcher.dispatch("alerts.test", { destination: "ops" }, session()),
      ).resolves.toEqual({ destination: "ops", status: 200 });

      await expect(
        configured.dispatcher.dispatch("alerts.test", { destination: "nope" }, session()),
      ).rejects.toMatchObject(unknown);
      await expect(
        harness().dispatcher.dispatch("alerts.test", { destination: "nope" }, session()),
      ).rejects.toMatchObject(unknown);
      await expect(
        configured.dispatcher.dispatch("alerts.test", { destination: "o" }, session()),
      ).rejects.toMatchObject({ code: "UNKNOWN_ALERT_DESTINATION", details: { destination: "o" } });

      expect(configured.poster.requests).toHaveLength(1);
    });

    it("a refused connection answers could not be reached with the network code, and neither the answer nor the failed call's operation log line holds the URL", async () => {
      const closedPort = await new Promise<number>((resolve) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address() as { port: number };
          server.close(() => resolve(port));
        });
      });
      const url = `http://127.0.0.1:${closedPort}/hook-token-xyz`;
      const { dispatcher, logSink } = harness({
        alertDestinations: [{ ...generic, url }],
        webhookPoster: new FetchWebhookPoster(),
      });

      const failure = await dispatcher
        .dispatch("alerts.test", { destination: "ops" }, session())
        .then(
          () => undefined,
          (error: unknown) => error as { code: string; message: string; details: unknown },
        );

      expect(failure).toMatchObject({
        code: "ALERT_SEND_FAILED",
        message: "ops could not be reached: ECONNREFUSED",
        details: { destination: "ops", error: "ECONNREFUSED" },
      });
      expect(
        logSink.records
          .filter((record) => record.message === "operation")
          .map((record) => record.fields),
      ).toMatchObject([
        {
          operation: "alerts.test",
          code: "ALERT_SEND_FAILED",
          message: "ops could not be reached: ECONNREFUSED",
        },
      ]);
      for (const text of [JSON.stringify(failure), JSON.stringify(logSink.records)]) {
        expect(text).not.toContain("hook-token-xyz");
        expect(text).not.toContain(String(closedPort));
      }
    });

    it("alerts.test answers BAD_REQUEST for a destination of no characters or more than 32, and looks up one of 32", async () => {
      const { dispatcher, poster } = harness({ alertDestinations: [generic] });
      const longest = "n".repeat(32);

      for (const destination of ["", "n".repeat(33)]) {
        await expect(
          dispatcher.dispatch("alerts.test", { destination }, session()),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
      await expect(
        dispatcher.dispatch("alerts.test", { destination: longest }, session()),
      ).rejects.toMatchObject({ code: "UNKNOWN_ALERT_DESTINATION" });
      expect(poster.requests).toEqual([]);
    });

    it("stop during a test answers DAEMON_STOPPING", async () => {
      const { alerts, dispatcher, poster } = harness({ alertDestinations: [generic] });
      poster.respond = () => new Promise(() => {});
      let outcome: unknown = "pending";
      void dispatcher.dispatch("alerts.test", { destination: "ops" }, session()).then(
        (value) => (outcome = value),
        (error: unknown) => (outcome = error),
      );
      await vi.waitFor(() => expect(poster.requests).toHaveLength(1));
      expect(outcome).toBe("pending");

      alerts?.stop();
      await new Promise((resolve) => setImmediate(resolve));

      expect(outcome).toMatchObject({ code: "DAEMON_STOPPING" });
    });
  });

  describe("worker.install-component (ADR 0010 §7)", () => {
    function withWorker() {
      const fixture = harness();
      const worker = new ScriptedWorkerClient();
      fixture.workers.connected("wrk_1", undefined, "0.3.0");
      fixture.workers.refresh("wrk_1", {
        downloads: { policy: "on-request", timeoutMs: 60_000 },
      });
      fixture.directory.add("wrk_1", worker);
      return { ...fixture, worker };
    }

    it("refuses an agent session with FORBIDDEN and asks no worker", async () => {
      const { dispatcher, worker } = withWorker();

      await expect(
        dispatcher.dispatch(
          "worker.install-component",
          { platform: "android", version: "35", workers: "all" },
          session({ role: "agent" }),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(worker.calls.filter((call) => call.startsWith("component.install"))).toEqual([]);
    });

    it("opens the session's stream before asking a worker, and hands it each update with the worker's id", async () => {
      const { dispatcher, worker } = withWorker();
      const seen: unknown[] = [];
      worker.installComponentHandler = async (input, options) => {
        seen.push("asked");
        options.onProgress?.({ stage: "waiting" });
        return {
          component: input.version,
          outcome: "installed",
          platform: input.platform,
          version: input.version,
        };
      };

      const result = await dispatcher.dispatch(
        "worker.install-component",
        { platform: "android", version: "35", workers: ["wrk_1"] },
        session({
          onComponentProgress: (progress, workerId) => seen.push({ progress, workerId }),
          onStarted: () => seen.push("started"),
        }),
      );

      expect(seen).toEqual([
        "started",
        "asked",
        { progress: { stage: "waiting" }, workerId: "wrk_1" },
      ]);
      expect(result).toEqual({
        results: [{ outcome: "installed", version: "35", workerId: "wrk_1" }],
      });
    });
  });

  describe("UNSUPPORTED_IN_GATEWAY_MODE", () => {
    it.each([
      "nuke.run",
      "cleanup.run",
      "doctor.run",
      "driver.passthrough",
      "warm.forget",
    ] as const)("%s stays per-worker, permanently", async (operation) => {
      const { dispatcher } = harness();
      const input =
        operation === "driver.passthrough"
          ? { args: ["devices"], tool: "adb" }
          : operation === "warm.forget"
            ? { model: "Pixel", platform: "android" }
            : { fix: true };

      await expect(dispatcher.dispatch(operation, input, session())).rejects.toMatchObject({
        code: "UNSUPPORTED_IN_GATEWAY_MODE",
        details: { operation },
      });
    });

    it.each([
      [
        "component.install",
        { platform: "android", version: "35" },
        "admin",
        "component.install installs on one machine; on a gateway, name the workers to install on " +
          "(simlock component install --worker <id> or --all-workers)",
      ],
      [
        "seed.make",
        { model: "Pixel 8", platform: "android" },
        "admin",
        "seed acts on one machine's devices; run it against a worker",
      ],
      [
        "component.list",
        {},
        "agent",
        "component.list lists one machine's components; run it against a worker",
      ],
      [
        "component.remove",
        { platform: "ios", version: "26.4" },
        "admin",
        "component.remove removes a component from one machine; run it against a worker",
      ],
      [
        "device.add",
        { id: "00008110-001A2B3C4D5E", platform: "ios" },
        "admin",
        "device.add enrols a device plugged into one machine; run it on the worker the device is plugged into",
      ],
      [
        "device.remove",
        { id: "00008110-001A2B3C4D5E" },
        "admin",
        "device.remove unenrols a device plugged into one machine; run it on the worker the device is plugged into",
      ],
    ] as const)(
      "%s answers UNSUPPORTED_IN_GATEWAY_MODE with a message pointing at the worker",
      async (operation, input, role, message) => {
        const { dispatcher } = harness();

        await expect(
          dispatcher.dispatch(operation, input, session({ role })),
        ).rejects.toMatchObject({
          code: "UNSUPPORTED_IN_GATEWAY_MODE",
          details: { operation },
          message,
        });
      },
    );
  });

  describe("daemon.update", () => {
    it("asks the gateway's own update coordinator and answers with its outcome, the gateway's version and its health, and status.get carries the update and its last failure", async () => {
      const { dispatcher, update } = harness();
      const run = {
        forced: true,
        from: "0.0.0-test",
        stage: "installing",
        startedAt: 1_000,
        to: "0.4.0",
      } as const;
      const failure = {
        at: 500,
        from: "0.0.0-test",
        message: "npm failed",
        stage: "installing",
        to: "0.3.0",
      } as const;
      update.progress = { lastUpdateFailure: failure, latestVersion: "0.4.0", update: run };

      await expect(
        dispatcher.dispatch("daemon.update", { force: true }, session({ role: "admin" })),
      ).resolves.toEqual({
        health: "running",
        lastUpdateFailure: failure,
        latestVersion: "0.4.0",
        resolved: "0.4.0",
        started: true,
        update: run,
        upToDate: false,
        version: "0.0.0-test",
      });
      expect(update.requests).toEqual([{ force: true }]);

      const status = await dispatcher.dispatch("status.get", {}, session({ role: "admin" }));
      expect(status.daemon).toMatchObject({ lastUpdateFailure: failure, update: run });
    });
  });
});
