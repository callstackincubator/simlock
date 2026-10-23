import { readFile } from "node:fs/promises";
import { join } from "node:path";

// why: the device stream is asked for by the worker's own id, which a single worker keeps in its
// `instance.json`; a lane that streams reads it there instead of asking the daemon, so the URL it
// builds is the one an operator's tool would.
export async function deviceStreamUrl(
  base: string,
  home: string,
  deviceId: string,
): Promise<string> {
  const instance = JSON.parse(await readFile(join(home, "instance.json"), "utf8")) as {
    readonly instanceId: string;
  };
  return `${base}/v1/stream/workers/${encodeURIComponent(instance.instanceId)}/devices/${encodeURIComponent(deviceId)}`;
}
