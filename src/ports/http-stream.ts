import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const CONNECT_TIMEOUT_MS = 10_000;

export interface HttpStreamRequest {
  readonly method: "GET" | "PUT" | "DELETE";
  readonly url: string;
  readonly token: string;
  /** why: streamed as it is read, so a file of any size never sits in memory. */
  readonly body?: ReadableStream<Uint8Array> | undefined;
  readonly contentLength?: number | undefined;
  /** why: the caller owns the wait once the connection is made (how long a silence it bears), so it ends the call by aborting. */
  readonly signal: AbortSignal;
}

export interface HttpStreamAnswer {
  readonly status: number;
  readonly body: ReadableStream<Uint8Array>;
}

export interface HttpStreamClient {
  // why: one call with a bearer token and no cap on either body; a connection not made in 10 s rejects, and so does an abort.
  request(request: HttpStreamRequest): Promise<HttpStreamAnswer>;
}

export class NodeHttpStreamClient implements HttpStreamClient {
  request(request: HttpStreamRequest): Promise<HttpStreamAnswer> {
    return new Promise((resolve, reject) => {
      const url = new URL(request.url);
      const send = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          headers: {
            authorization: `Bearer ${request.token}`,
            ...(request.contentLength === undefined
              ? {}
              : { "content-length": String(request.contentLength) }),
          },
          method: request.method,
          signal: request.signal,
        },
        (response) =>
          resolve({
            body: Readable.toWeb(response) as ReadableStream<Uint8Array>,
            status: response.statusCode ?? 0,
          }),
      );
      send.once("socket", (socket) => {
        if (!socket.connecting) return;
        const timer = setTimeout(() => {
          send.destroy(new Error("The connection was not made in time"));
        }, CONNECT_TIMEOUT_MS);
        socket.once("connect", () => clearTimeout(timer));
        send.once("close", () => clearTimeout(timer));
      });
      send.once("error", reject);
      if (request.body === undefined) send.end();
      else pipeline(Readable.fromWeb(request.body as never), send).catch(reject);
    });
  }
}

export type FakeHttpStreamReply = (request: HttpStreamRequest) => Promise<HttpStreamAnswer>;

export class FakeHttpStreamClient implements HttpStreamClient {
  readonly requests: { readonly method: string; readonly url: string; readonly token: string }[] =
    [];
  // why: a test scripts the answer to each call; with none scripted a call rejects, as an unreachable host does.
  reply: FakeHttpStreamReply = async (request) => {
    throw new Error(`no answer scripted for ${request.method} ${request.url}`);
  };

  async request(request: HttpStreamRequest): Promise<HttpStreamAnswer> {
    this.requests.push({ method: request.method, token: request.token, url: request.url });
    return this.reply(request);
  }
}
