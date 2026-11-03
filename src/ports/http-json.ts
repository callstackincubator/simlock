const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1_048_576;

export interface HttpJsonAnswer {
  readonly status: number;
  readonly body: unknown;
}

export interface HttpJsonClient {
  // why: one GET with a bearer token; a connection that fails, a silent server and a body past 1 MiB all reject.
  get(url: string, token: string): Promise<HttpJsonAnswer>;
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    total += step.value.length;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error(`The answer is longer than ${String(MAX_BODY_BYTES)} bytes`);
    }
    chunks.push(step.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class FetchHttpJsonClient implements HttpJsonClient {
  async get(url: string, token: string): Promise<HttpJsonAnswer> {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await readCapped(response);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { body, status: response.status };
  }
}

export class FakeHttpJsonClient implements HttpJsonClient {
  readonly requests: { readonly url: string; readonly token: string }[] = [];
  // why: a test scripts each URL's answer; a URL with no entry rejects, as an unreachable host does.
  readonly answers = new Map<string, HttpJsonAnswer>();

  async get(url: string, token: string): Promise<HttpJsonAnswer> {
    this.requests.push({ token, url });
    const answer = this.answers.get(url);
    if (answer === undefined) throw new Error(`no answer scripted for ${url}`);
    return answer;
  }
}
