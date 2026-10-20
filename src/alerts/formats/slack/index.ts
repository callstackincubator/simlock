import type { AlertEventName } from "../../../core/index.js";
import type { AlertFormatDefinition } from "../types.js";
import { SLACK_MESSAGES } from "./messages.js";
import { part } from "./units.js";

export const slackFormat: AlertFormatDefinition = {
  name: "slack",
  build({ envelope, version, workerLabel }) {
    const payload = envelope.payload as Record<string, unknown>;
    const message = SLACK_MESSAGES[envelope.event as AlertEventName | "alerts.test-sent"];
    return {
      body: JSON.stringify({ text: message(payload, part(workerLabel(String(payload.workerId)))) }),
      headers: { "Content-Type": "application/json", "User-Agent": `simlock/${version}` },
    };
  },
};
