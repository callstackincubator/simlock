import { describe, expect, it } from "vitest";

import { mintJoinToken, type TestEnv, withDaemon, withHttpDaemon } from "./helpers/index.js";

const REDACTED = "[redacted]";

const DESTINATIONS = [
  {
    name: "ops",
    format: "generic",
    url: "http://127.0.0.1:9/hooks/ops-secret-path",
    events: ["device.recovery-failed"],
    secret: "ops-signing-secret",
  },
  {
    name: "team",
    format: "slack",
    url: "https://hooks.slack.example/services/T000/B000/team-secret-path",
    events: ["device.quarantine-abandoned"],
  },
] as const;

const REDACTED_DESTINATIONS = [
  { ...DESTINATIONS[0], url: REDACTED, secret: REDACTED },
  { ...DESTINATIONS[1], url: REDACTED },
];

async function printed(env: TestEnv, args: readonly string[]): Promise<unknown> {
  const result = await env.cli(args);
  return result.code === 0 ? result.json : `exit ${String(result.code)}: ${result.stderr.trim()}`;
}

function gatewayKey(config: unknown, key: "token" | "alerts"): unknown {
  if (typeof config === "string") return config;
  const gateway = (config as { gateway?: Record<string, unknown> } | undefined)?.gateway;
  return key === "alerts"
    ? (gateway?.alerts as { destinations?: unknown } | undefined)?.destinations
    : gateway?.token;
}

describe("simlock config hides secrets unless asked", () => {
  it("simlock config and config get print [redacted] for gateway.token and every alert destination's url and secret, and --show-secrets prints the real values", async () => {
    const { env: gateway, port } = await withHttpDaemon((port) => ({
      configOverrides: {
        http: { enabled: true, host: "127.0.0.1", port },
        gateway: { alerts: { destinations: DESTINATIONS } },
      },
      role: "gateway",
      driver: "none",
    }));
    const joinToken = await mintJoinToken(gateway);
    const worker = await withDaemon({
      configOverrides: { gateway: { token: joinToken, url: `ws://127.0.0.1:${String(port)}` } },
    });

    const outputs = {
      workerConfig: gatewayKey(await printed(worker, ["config"]), "token"),
      workerGet: await printed(worker, ["config", "get", "gateway.token"]),
      gatewayConfig: gatewayKey(await printed(gateway, ["config"]), "alerts"),
      gatewayGet: await printed(gateway, ["config", "get", "gateway.alerts.destinations"]),
      workerConfigShown: gatewayKey(await printed(worker, ["config", "--show-secrets"]), "token"),
      workerGetShown: await printed(worker, ["config", "get", "gateway.token", "--show-secrets"]),
      gatewayConfigShown: gatewayKey(
        await printed(gateway, ["config", "--show-secrets"]),
        "alerts",
      ),
      gatewayGetShown: await printed(gateway, [
        "config",
        "get",
        "gateway.alerts.destinations",
        "--show-secrets",
      ]),
      flagBeforeGet: await printed(worker, ["config", "--show-secrets", "get", "gateway.token"]),
    };

    expect(outputs).toEqual({
      workerConfig: REDACTED,
      workerGet: REDACTED,
      gatewayConfig: REDACTED_DESTINATIONS,
      gatewayGet: REDACTED_DESTINATIONS,
      workerConfigShown: joinToken,
      workerGetShown: joinToken,
      gatewayConfigShown: DESTINATIONS,
      gatewayGetShown: DESTINATIONS,
      flagBeforeGet: `exit 2: {"error":{"code":"USAGE","message":"Unknown config command: get"}}`,
    });
  });
});
