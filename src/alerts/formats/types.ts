import type { EventEnvelope } from "../../bus/index.js";
import type { AlertDestination, AlertFormatName } from "../../core/index.js";

export interface AlertFormatDefinition {
  readonly name: AlertFormatName;
  build(input: {
    envelope: EventEnvelope;
    destination: AlertDestination;
    version: string;
    workerLabel(id: string): string;
  }): { headers: Record<string, string>; body: string };
}
