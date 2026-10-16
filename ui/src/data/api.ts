const REQUEST_TIMEOUT_MS = 10_000;

// why: relative, so the browser sends it to the page's own origin only.
export type ApiPath = `/v1/${string}`;

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class RequestTimeoutError extends Error {
  constructor(path: ApiPath, timeoutMs: number = REQUEST_TIMEOUT_MS) {
    super(`The daemon did not answer ${path} within ${String(timeoutMs / 1000)} seconds`);
    this.name = "RequestTimeoutError";
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface SendOptions {
  readonly fetch: Fetch;
  readonly token?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export async function send<T>(
  path: ApiPath,
  options: SendOptions,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  // why: the type says this already; the check keeps a path built at runtime from ever sending the
  // token anywhere but this origin's API.
  if (!path.startsWith("/v1/")) throw new Error(`Not an API path: ${path}`);
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  if (options.signal?.aborted === true) abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await options.fetch(path, {
      cache: "no-store",
      credentials: "omit",
      headers: options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` },
      signal: controller.signal,
    });
    return await read(response);
  } catch (error: unknown) {
    if (timedOut) throw new RequestTimeoutError(path, timeoutMs);
    throw error;
  } finally {
    // why: the `abort` listener stays: a streamed body is still being read after this returns, and
    // `signal` is how its reader closes it.
    clearTimeout(timer);
  }
}

export interface ApiResponse<T> {
  readonly body: T;
  readonly date: string | null;
}

export interface ApiClient {
  getJson<T>(path: ApiPath): Promise<T>;
  get<T>(path: ApiPath): Promise<ApiResponse<T>>;
  // why: a stream's bound, 10 seconds unless `headTimeoutMs` says otherwise, covers its headers
  // only; the body stays open until it ends or `signal` aborts it.
  stream(
    path: ApiPath,
    signal: AbortSignal,
    headTimeoutMs?: number,
  ): Promise<ApiResponse<ReadableStream<Uint8Array>>>;
  healthz(): Promise<ApiResponse<boolean>>;
}

export interface ApiClientOptions {
  readonly fetch: Fetch;
  readonly token: () => string | undefined;
  readonly signOut: () => void;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const authorized = (signal?: AbortSignal, timeoutMs?: number): SendOptions => {
    const token = options.token();
    return {
      fetch: options.fetch,
      ...(token === undefined ? {} : { token }),
      ...(signal === undefined ? {} : { signal }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  };
  const get = <T>(path: ApiPath) =>
    send(path, authorized(), async (response) => {
      await refuseError(response, options.signOut);
      return { body: (await response.json()) as T, date: response.headers.get("Date") };
    });
  return {
    get,
    getJson: async <T>(path: ApiPath) => (await get<T>(path)).body,
    stream: (path, signal, headTimeoutMs) =>
      send(path, authorized(signal, headTimeoutMs), async (response) => {
        await refuseError(response, options.signOut);
        if (response.body === null) throw new ApiError(response.status, undefined, "No body");
        return { body: response.body, date: response.headers.get("Date") };
      }),
    healthz: () =>
      send("/v1/healthz", { fetch: options.fetch }, async (response) => ({
        body: response.ok,
        date: response.headers.get("Date"),
      })),
  };
}

async function refuseError(response: Response, signOut: () => void): Promise<void> {
  if (response.status === 401) signOut();
  if (!response.ok) throw await apiError(response);
}

async function apiError(response: Response): Promise<ApiError> {
  const fallback = `The daemon answered ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    const code = typeof body.error?.code === "string" ? body.error.code : undefined;
    const message = typeof body.error?.message === "string" ? body.error.message : fallback;
    return new ApiError(response.status, code, message);
  } catch {
    return new ApiError(response.status, undefined, fallback);
  }
}
