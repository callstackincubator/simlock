import type { AlertDestination } from "../core/index.js";
import type { Clock, IdGenerator, WebhookPoster } from "../ports/index.js";
import { errorCode } from "./error-code.js";
import { ALERT_FORMAT_REGISTRY } from "./formats/index.js";

const TEST_TIMEOUT_MS = 10_000;

export type AlertTestResult =
  | { readonly ok: true; readonly status: number }
  | {
      readonly ok: false;
      readonly reason: "unknown-destination" | "stopped" | "status" | "unreachable" | "timeout";
      readonly status?: number;
      readonly error?: string;
    };

export function sendTest(options: {
  destination: AlertDestination;
  poster: WebhookPoster;
  clock: Clock;
  idGenerator: IdGenerator;
  stopSignal: AbortSignal;
  version: string;
  workerLabel(workerId: string): string;
}): Promise<AlertTestResult> {
  const { destination, poster, clock, idGenerator, stopSignal, version, workerLabel } = options;
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
  const controller = new AbortController();
  return new Promise((resolve) => {
    const timer = clock.setTimer(TEST_TIMEOUT_MS, () => {
      controller.abort();
      settle({ ok: false, reason: "timeout" });
    });
    const settle = (result: AlertTestResult): void => {
      clock.cancel(timer);
      stopSignal.removeEventListener("abort", onStop);
      resolve(result);
    };
    const onStop = (): void => {
      controller.abort();
      settle({ ok: false, reason: "stopped" });
    };
    stopSignal.addEventListener("abort", onStop, { once: true });
    let pending: Promise<{ status: number }>;
    try {
      pending = poster.post({
        url: destination.url,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      ({ status }) =>
        settle(
          status >= 200 && status < 300
            ? { ok: true, status }
            : { ok: false, reason: "status", status },
        ),
      (error: unknown) => settle({ ok: false, reason: "unreachable", error: errorCode(error) }),
    );
  });
}
