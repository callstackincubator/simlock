import { PROTOCOL_VERSION_RANGE, type Role } from "../contract/index.js";
import { FakeWebSocketClientConnector, type WebSocketClient } from "../ports/index.js";

export type FarmAnswer = (payload: unknown) => unknown;

export interface FarmRequest {
  readonly type: string;
  readonly payload: unknown;
}

// why: stands in for a farm's session path: it answers `hello` as a farm does and every other request from `answers` by its type, or with a `BAD_REQUEST` naming the type nobody scripted. An answer that is an `Error` with a `code` is sent as a failure frame.
export class FakeFarm extends FakeWebSocketClientConnector {
  readonly requests: FarmRequest[] = [];

  constructor(
    private readonly answers: Readonly<Record<string, FarmAnswer>> = {},
    private readonly role: Role = "agent",
  ) {
    super();
  }

  override async connect(
    url: string,
    options: Parameters<FakeWebSocketClientConnector["connect"]>[1],
  ): Promise<WebSocketClient> {
    const peer = await super.connect(url, options);
    const connection = this.connections.at(-1)?.peer;
    if (connection === undefined) return peer;
    const sendText = connection.sendText.bind(connection);
    connection.sendText = (text: string): void => {
      sendText(text);
      queueMicrotask(() => {
        const frame = JSON.parse(text) as { id: number; type: string; payload: unknown };
        this.requests.push({ payload: frame.payload, type: frame.type });
        connection.receive(new TextEncoder().encode(JSON.stringify(this.#reply(frame))));
      });
    };
    return peer;
  }

  #reply(frame: { id: number; type: string; payload: unknown }): unknown {
    if (frame.type === "hello") {
      return {
        id: frame.id,
        ok: true,
        payload: {
          daemonProtocolRange: PROTOCOL_VERSION_RANGE,
          principal: "tok_1",
          protocolVersion: PROTOCOL_VERSION_RANGE.max,
          role: this.role,
          version: "0.0.0-test",
        },
      };
    }
    const answer = this.answers[frame.type];
    if (answer === undefined) {
      return {
        error: { code: "BAD_REQUEST", message: `unscripted ${frame.type}` },
        id: frame.id,
        ok: false,
      };
    }
    const result = answer(frame.payload);
    if (result instanceof Error && "code" in result) {
      return { error: { code: result.code, message: result.message }, id: frame.id, ok: false };
    }
    return { id: frame.id, ok: true, payload: result };
  }

  requestTypes(): string[] {
    return this.requests.map(({ type }) => type).filter((type) => type !== "hello");
  }
}
