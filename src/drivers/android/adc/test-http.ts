import type { HttpJsonRequester } from "../../../ports/index.js";

export type HttpJsonRequest = Parameters<HttpJsonRequester["request"]>[0];
export type HttpJsonAnswer = Awaited<ReturnType<HttpJsonRequester["request"]>>;

export class FakeHttpJsonRequester implements HttpJsonRequester {
  readonly requests: HttpJsonRequest[] = [];
  readonly answers = new Map<string, HttpJsonAnswer>();

  async request(input: HttpJsonRequest): Promise<HttpJsonAnswer> {
    this.requests.push(input);
    const key = `${input.method} ${input.url}`;
    const answer = this.answers.get(key);
    if (answer === undefined) throw new Error(`no answer scripted for ${key}`);
    return answer;
  }
}
