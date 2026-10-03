/**
 * The one way the console talks to the daemon (ADR 0011 §6). Every request goes to `/v1` on the
 * page's own origin, carries the operator token only as `Authorization: Bearer`, and gives up
 * after 10 seconds. Views never call `fetch` themselves.
 */

/** ADR 0013 §3: every request gives up after this long. */
const REQUEST_TIMEOUT_MS = 10_000;

/** A path on the daemon's API. Relative, so the browser sends it to the page's own origin only. */
export type ApiPath = `/v1/${string}`;

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** The daemon did not answer within {@link REQUEST_TIMEOUT_MS}. */
export class RequestTimeoutError extends Error {
  constructor(path: ApiPath) {
    super(`The daemon did not answer ${path} within ${REQUEST_TIMEOUT_MS / 1000} seconds`);
    this.name = "RequestTimeoutError";
  }
}

/** The daemon answered with an error status. `code` is the API's own error code, when it sent one. */
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
  /** Absent for the one route that needs none, `GET /v1/healthz`. */
  readonly token?: string;
  /** Aborts the request, and the body of a response already handed back. */
  readonly signal?: AbortSignal;
}

/**
 * One request, bounded by {@link REQUEST_TIMEOUT_MS} from the moment it is sent until `read`
 * has finished with the body. A timeout rejects with {@link RequestTimeoutError}; a request
 * that never reached the daemon rejects with what `fetch` threw.
 */
export async function send<T>(
  path: ApiPath,
  options: SendOptions,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  // The type says this already; the check keeps a path built at runtime from ever sending the
  // token anywhere but this origin's API.
  if (!path.startsWith("/v1/")) throw new Error(`Not an API path: ${path}`);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
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
    if (timedOut) throw new RequestTimeoutError(path);
    throw error;
  } finally {
    // The `abort` listener stays: a streamed body is still being read after this returns, and
    // `signal` is how its reader closes it.
    clearTimeout(timer);
  }
}

/** A response's body, with the `Date` header the daemon sent it with (ADR 0013 §4). */
export interface ApiResponse<T> {
  readonly body: T;
  /** The raw `Date` header, or `null` when the response had none. */
  readonly date: string | null;
}

export interface ApiClient {
  /** `GET` a route and parse its JSON. Rejects with {@link ApiError} on any error status. */
  getJson<T>(path: ApiPath): Promise<T>;
  /** {@link getJson}, with the response's `Date` header. */
  get<T>(path: ApiPath): Promise<ApiResponse<T>>;
  /**
   * Opens a streaming route and hands back its body once the headers arrive. The 10-second
   * bound covers the headers only; the body is open until it ends or `signal` aborts it.
   */
  stream(path: ApiPath, signal: AbortSignal): Promise<ApiResponse<ReadableStream<Uint8Array>>>;
  /** `GET /v1/healthz`, with no token: whether the daemon answered with success. */
  healthz(): Promise<ApiResponse<boolean>>;
}

export interface ApiClientOptions {
  readonly fetch: Fetch;
  /** The signed-in operator's token, read on every request. */
  readonly token: () => string | undefined;
  /** ADR 0011 §6: a `401` at any time signs the operator out. */
  readonly signOut: () => void;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const authorized = (signal?: AbortSignal): SendOptions => {
    const token = options.token();
    return {
      fetch: options.fetch,
      ...(token === undefined ? {} : { token }),
      ...(signal === undefined ? {} : { signal }),
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
    stream: (path, signal) =>
      send(path, authorized(signal), async (response) => {
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

/** Throws {@link ApiError} for an error status; a `401` signs the operator out first. */
async function refuseError(response: Response, signOut: () => void): Promise<void> {
  if (response.status === 401) signOut();
  if (!response.ok) throw await apiError(response);
}

/** The API's error body is `{ error: { code, message } }`; anything else still fails by status. */
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
