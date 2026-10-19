import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { waitFor } from "../helpers/wait.js";
import { assertLanePortsFree } from "./ports.js";

const run = promisify(execFile);
const LANE_DIR = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = join(LANE_DIR, "compose.yaml");
const WAIT_MS = 60_000;

async function compose(...args: readonly string[]): Promise<void> {
  await run("docker", ["compose", "-f", COMPOSE_FILE, ...args], { timeout: 180_000 });
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function up(container: string, address: string): Promise<void> {
  await compose("up", "-d", container);
  await waitFor(() => answers(address), {
    label: `${container} answering at ${address}`,
    timeout: WAIT_MS,
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  await assertLanePortsFree();
  try {
    await up("dex", "http://127.0.0.1:5556/dex/.well-known/openid-configuration");
    await up("oauth2-proxy", "http://127.0.0.1:4180/ping");
  } catch (error: unknown) {
    await compose("down", "-v").catch(() => undefined);
    throw error;
  }
  return () => compose("down", "-v");
}
