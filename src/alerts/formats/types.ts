import type { EventEnvelope } from "../../bus/index.js";
import type { AlertDestination, AlertFormatName } from "../../core/index.js";

/** why: the sample `Alerts.test` builds: shaped like an envelope, but never on the bus. */
export interface AlertTestEnvelope {
  readonly id: string;
  readonly seq: 0;
  readonly timestamp: number;
  readonly event: "alerts.test-sent";
  readonly payload: { readonly destination: string };
  readonly module: "alerts";
}

export type AlertEnvelope = EventEnvelope | AlertTestEnvelope;

export interface AlertFormatDefinition {
  readonly name: AlertFormatName;
  build(input: {
    envelope: AlertEnvelope;
    destination: AlertDestination;
    version: string;
    workerLabel(id: string): string;
  }): { headers: Record<string, string>; body: string };
}
