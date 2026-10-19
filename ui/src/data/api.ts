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
      credentials: "same-origin",
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

export type ApiFailure = "unauthorized" | "not-simlock";

export interface ApiClientOptions {
  readonly fetch: Fetch;
  readonly token: () => string | undefined;
  // why: what a 401 does when nobody takes `onRefused`; the console's session takes it, because
  // what a 401 means depends on whether a token or a sign-in proxy made the session.
  readonly signOut?: () => void;
  readonly onRefused?: (failure: ApiFailure) => void;
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
  const refuse = (failure: ApiFailure, status?: number) => {
    if (options.onRefused !== undefined) options.onRefused(failure);
    else if (status === 401) options.signOut?.();
  };
  const watched = async <T>(
    path: ApiPath,
    sendOptions: SendOptions,
    read: (response: Response) => Promise<T>,
  ): Promise<T> => {
    try {
      return await send(path, sendOptions, async (response) => {
        await refuseError(response, refuse);
        return read(response);
      });
    } catch (error: unknown) {
      // why: a request that never got an answer (a redirect `fetch` cannot follow, a dropped
      // connection) may be the sign-in proxy's session ending; a timeout or an abort is not.
      if (isNetworkError(error, sendOptions.signal)) refuse("not-simlock");
      throw error;
    }
  };
  const get = <T>(path: ApiPath) =>
    watched(path, authorized(), async (response) => ({
      body: (await response.json()) as T,
      date: response.headers.get("Date"),
    }));
  return {
    get,
    getJson: async <T>(path: ApiPath) => (await get<T>(path)).body,
    stream: (path, signal, headTimeoutMs) =>
      watched(path, authorized(signal, headTimeoutMs), async (response) => {
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

function isNetworkError(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    !(error instanceof ApiError) &&
    !(error instanceof RequestTimeoutError) &&
    signal?.aborted !== true &&
    error instanceof TypeError
  );
}

export function hasSimlockErrorCode(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const error = (body as { error?: unknown }).error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

async function refuseError(
  response: Response,
  refuse: (failure: ApiFailure, status: number) => void,
): Promise<void> {
  if (response.ok) return;
  const error = await apiError(response);
  const status = response.status;
  if ((status === 401 || status === 403) && error.code === undefined) refuse("not-simlock", status);
  else if (status === 401) refuse("unauthorized", status);
  throw error;
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
