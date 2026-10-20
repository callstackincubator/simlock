import type { AlertDestination } from "../core/index.js";
import type { Clock, IdGenerator, WebhookPoster } from "../ports/index.js";
import { ALERT_FORMAT_REGISTRY } from "./formats/index.js";

export type AlertTestResult = { readonly ok: true; readonly status: number };

export async function sendTest(options: {
  destination: AlertDestination;
  poster: WebhookPoster;
  clock: Clock;
  idGenerator: IdGenerator;
  version: string;
  workerLabel(workerId: string): string;
}): Promise<AlertTestResult> {
  const { destination, poster, clock, idGenerator, version, workerLabel } = options;
  const request = ALERT_FORMAT_REGISTRY[destination.format].build({
    envelope: {
      id: `evt_${idGenerator.generate()}`,
      seq: 0,
      timestamp: clock.now(),
      event: "alerts.test-sent",
      payload: { destination: destination.name },
      module: "alerts",
    },
    destination,
    version,
    workerLabel,
  });
  const { status } = await poster.post({
    url: destination.url,
    headers: request.headers,
    body: request.body,
    signal: new AbortController().signal,
  });
  return { ok: true, status };
}
