// why: the real WebSocket adapters stay out of the ports barrel so the CLI never loads `ws`; tests that need them import them from here.
export { WebSocketUplinkConnector, WebSocketUplinkListenerFactory } from "./uplink-websocket.js";
import type { WebhookPoster, WebhookRequest } from "./webhook-poster.js";

export class FakeWebhookPoster implements WebhookPoster {
  readonly requests: WebhookRequest[] = [];
  respond: (request: WebhookRequest, index: number) => Promise<{ status: number }> = () =>
    Promise.resolve({ status: 200 });

  post(request: WebhookRequest): Promise<{ status: number }> {
    this.requests.push(request);
    return this.respond(request, this.requests.length - 1);
  }
}
