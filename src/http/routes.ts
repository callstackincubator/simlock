import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import { describeSchemaIssues } from "../contract/index.js";
import { badRequest, errorResponse } from "./errors.js";

export type RouteRole = "public" | "agent" | "admin";
type RouteTag =
  | "System"
  | "Devices"
  | "Lease requests"
  | "Leases"
  | "Workers"
  | "Components"
  | "Tokens"
  | "Events";
type SuccessStatus = 200 | 201 | 202 | 204;
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 415 | 422 | 500 | 501 | 503 | 504;
type JsonContent<Schema extends z.ZodType> = { "application/json": { schema: Schema } };
type ErrorBody = { error: { code: string; message: string } };
type ErrorResponse = {
  description: string;
  content: JsonContent<z.ZodType<ErrorBody>>;
  headers?: z.ZodObject<z.ZodRawShape>;
};
// why: an error status can carry body fields and response headers beyond `code` and `message`, and the document names them.
type ErrorExtras = Partial<
  Record<ErrorStatus, { readonly fields?: z.ZodRawShape; readonly headers?: z.ZodRawShape }>
>;

export const BEARER_SCHEME = "bearer";

const BASE_CODES = {
  400: ["BAD_REQUEST"],
  401: ["UNAUTHENTICATED"],
  403: ["FORBIDDEN"],
  415: ["UNSUPPORTED_MEDIA_TYPE"],
  500: ["INTERNAL"],
  503: ["DAEMON_STOPPING", "DAEMON_STARTUP_FAILED"],
} as const;

type RequestSchemas = {
  readonly query?: z.ZodType;
  readonly params?: z.ZodType;
  readonly headers?: z.ZodType;
  readonly json?: z.ZodType;
  readonly optionalJson?: z.ZodType;
};

type DeclaredRequest<Request extends RequestSchemas> = (Request["query"] extends z.ZodType
  ? { query: Request["query"] }
  : {}) &
  (Request["params"] extends z.ZodType ? { params: Request["params"] } : {}) &
  (Request["headers"] extends z.ZodType ? { headers: Request["headers"] } : {}) &
  (Request["json"] extends z.ZodType
    ? { body: { required: true; content: JsonContent<Request["json"]> } }
    : {}) &
  (Request["optionalJson"] extends z.ZodType
    ? { body: { required: false; content: JsonContent<Request["optionalJson"]> } }
    : {});

type BaseStatuses<Role extends RouteRole, Request extends RequestSchemas> =
  | 500
  | 503
  | (Role extends "public" ? never : 401 | 403)
  | (keyof Request extends never ? never : 400)
  | (Request["json"] extends z.ZodType ? 415 : never)
  | (Request["optionalJson"] extends z.ZodType ? 415 : never);

type SuccessResponse<
  Reply extends z.ZodType | undefined,
  Stream extends z.ZodType | undefined,
> = Stream extends z.ZodType
  ? { description: string; content: { "text/event-stream": { schema: Stream } } }
  : Reply extends z.ZodType
    ? { description: string; content: JsonContent<Reply> }
    : { description: string };

type DeclaredResponses<
  Reply extends z.ZodType | undefined,
  Stream extends z.ZodType | undefined,
  Success extends SuccessStatus,
  Statuses extends ErrorStatus,
> = { [Status in Success]: SuccessResponse<Reply, Stream> } & {
  [Status in Statuses]: ErrorResponse;
};

interface Declaration<
  Path extends string,
  Role extends RouteRole,
  Request extends RequestSchemas,
  Reply extends z.ZodType | undefined,
  Stream extends z.ZodType | undefined,
  Success extends SuccessStatus,
  Own extends Partial<Record<ErrorStatus, readonly string[]>>,
> {
  readonly method: "get" | "post" | "delete";
  readonly path: Path;
  readonly tag: RouteTag;
  readonly summary: string;
  readonly role: Role;
  readonly notes?: string;
  readonly request?: Request;
  readonly reply?: Reply;
  readonly stream?: Stream;
  readonly replyHeaders?: z.ZodType;
  readonly status?: Success;
  readonly errors?: Own;
  readonly errorExtras?: ErrorExtras;
}

function errorSchema(codes: readonly string[], fields: z.ZodRawShape = {}): z.ZodType<ErrorBody> {
  return z.object({
    error: z
      .object({ code: z.enum(codes as [string, ...string[]]), message: z.string(), ...fields })
      .catchall(z.unknown()),
  }) as z.ZodType<ErrorBody>;
}

function declaredErrors(
  role: RouteRole,
  request: RequestSchemas,
  own: Partial<Record<ErrorStatus, readonly string[]>>,
  extras: ErrorExtras,
): Record<number, ErrorResponse> {
  const codes = new Map<ErrorStatus, string[]>();
  const add = (status: ErrorStatus, list: readonly string[]) =>
    codes.set(status, [...(codes.get(status) ?? []), ...list]);
  for (const [status, list] of Object.entries(own)) add(Number(status) as ErrorStatus, list);
  if (role !== "public") {
    add(401, BASE_CODES[401]);
    add(403, BASE_CODES[403]);
  }
  if (Object.keys(request).length > 0) add(400, BASE_CODES[400]);
  if (request.json !== undefined || request.optionalJson !== undefined) {
    add(415, BASE_CODES[415]);
  }
  add(500, BASE_CODES[500]);
  add(503, BASE_CODES[503]);
  return Object.fromEntries(
    [...codes].map(([status, list]) => [
      status,
      {
        description: `Error codes: ${list.join(", ")}.`,
        content: {
          "application/json": { schema: errorSchema(list, extras[status as ErrorStatus]?.fields) },
        },
        ...(extras[status as ErrorStatus]?.headers === undefined
          ? {}
          : { headers: z.object(extras[status as ErrorStatus]!.headers!) }),
      },
    ]),
  );
}

function successContent(declaration: {
  readonly reply?: z.ZodType | undefined;
  readonly stream?: z.ZodType | undefined;
}) {
  if (declaration.stream !== undefined) {
    return { content: { "text/event-stream": { schema: declaration.stream } } };
  }
  if (declaration.reply !== undefined) {
    return { content: { "application/json": { schema: declaration.reply } } };
  }
  return {};
}

export function sseMessage(events: Readonly<Record<string, z.ZodType>>) {
  const names = Object.keys(events) as [string, ...string[]];
  const payloads = [...new Set(Object.values(events))];
  return z.object({
    data: payloads.length === 1 ? payloads[0]! : z.union(payloads as [z.ZodType, z.ZodType]),
    event: z.enum(names),
  });
}

export function declareRoute<
  const Path extends string,
  const Role extends RouteRole,
  const Request extends RequestSchemas = {},
  const Reply extends z.ZodType | undefined = undefined,
  const Stream extends z.ZodType | undefined = undefined,
  const Success extends SuccessStatus = 200,
  const Own extends Partial<Record<ErrorStatus, readonly string[]>> = {},
>(declaration: Declaration<Path, Role, Request, Reply, Stream, Success, Own>) {
  const request: RequestSchemas = declaration.request ?? {};
  const success = declaration.status ?? 200;
  const body = request.json ?? request.optionalJson;
  const responses = {
    [success]: {
      description: "Success",
      ...successContent(declaration),
      ...(declaration.replyHeaders === undefined ? {} : { headers: declaration.replyHeaders }),
    },
    ...declaredErrors(
      declaration.role,
      request,
      declaration.errors ?? {},
      declaration.errorExtras ?? {},
    ),
  } as DeclaredResponses<
    Reply,
    Stream,
    Success,
    (keyof Own & ErrorStatus) | BaseStatuses<Role, Request>
  >;
  return createRoute({
    method: declaration.method,
    path: declaration.path,
    tags: [declaration.tag],
    summary: declaration.summary,
    description: `Role: ${declaration.role === "public" ? "none, no token needed" : declaration.role}.${declaration.notes === undefined ? "" : ` ${declaration.notes}`}`,
    security: declaration.role === "public" ? [] : [{ [BEARER_SCHEME]: [] }],
    request: {
      ...(request.query === undefined ? {} : { query: request.query }),
      ...(request.params === undefined ? {} : { params: request.params }),
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(body === undefined
        ? {}
        : {
            body: {
              required: request.json !== undefined,
              content: { "application/json": { schema: body } },
            },
          }),
    } as DeclaredRequest<Request>,
    responses,
  });
}

export function firstValue<Schema extends z.ZodType>(schema: Schema) {
  return z.preprocess((value) => (Array.isArray(value) ? value[0] : value), schema);
}

export function validationHook(
  result: { success: true } | { success: false; error: z.ZodError },
  c: Context,
): Response | undefined {
  if (result.success) return undefined;
  return errorResponse(c, badRequest(describeSchemaIssues(result.error.issues)));
}

export const platformQuerySchema = z
  .object({ platform: firstValue(z.string().openapi({ enum: ["ios", "android"] })).optional() })
  .superRefine((query, context) => {
    if (query.platform !== undefined && query.platform !== "ios" && query.platform !== "android") {
      context.addIssue({ code: "custom", message: "platform must be ios or android", path: [] });
    }
  });
