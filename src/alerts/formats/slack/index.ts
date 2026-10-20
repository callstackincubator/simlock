import type { AlertFormatDefinition } from "../types.js";

export const slackFormat: AlertFormatDefinition = {
  name: "slack",
  build() {
    return { headers: {}, body: "" };
  },
};
