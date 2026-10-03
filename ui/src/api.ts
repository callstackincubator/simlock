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
    clearTimeout(timer);
  }
}

export interface ApiClient {
  /** `GET` a route and parse its JSON. Rejects with {@link ApiError} on any error status. */
  getJson<T>(path: ApiPath): Promise<T>;
}

export interface ApiClientOptions {
  readonly fetch: Fetch;
  /** The signed-in operator's token, read on every request. */
  readonly token: () => string | undefined;
  /** ADR 0011 §6: a `401` at any time signs the operator out. */
  readonly signOut: () => void;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  return {
    getJson: <T>(path: ApiPath) => {
      const token = options.token();
      return send(path, { fetch: options.fetch, ...(token === undefined ? {} : { token }) }, (r) =>
        readJson<T>(r, options.signOut),
      );
    },
  };
}

async function readJson<T>(response: Response, signOut: () => void): Promise<T> {
  if (response.status === 401) signOut();
  if (!response.ok) throw await apiError(response);
  return (await response.json()) as T;
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
