import { createHmac } from "node:crypto";

import type { AlertFormatDefinition } from "../types.js";

export const genericFormat: AlertFormatDefinition = {
  name: "generic",
  build({ envelope, destination, version }) {
    if (destination.secret === undefined) throw new Error("a generic destination has no secret");
    const body = JSON.stringify(envelope);
    const signature = createHmac("sha256", destination.secret).update(body).digest("hex");
    return {
      body,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `simlock/${version}`,
        "X-Simlock-Event": envelope.event,
        "X-Simlock-Delivery": envelope.id,
        "X-Simlock-Signature": `sha256=${signature}`,
      },
    };
  },
};
