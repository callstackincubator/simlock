import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import { describeSchemaIssues } from "../contract/index.js";
import { badRequest, errorResponse } from "./errors.js";

export type RouteRole = "public" | "agent" | "admin";
type RouteTag = "System" | "Devices";
type SuccessStatus = 200 | 201 | 202 | 204;
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 415 | 422 | 500 | 501 | 503;
type JsonContent<Schema extends z.ZodType> = { "application/json": { schema: Schema } };
type ErrorBody = { error: { code: string; message: string } };
type ErrorResponse = { description: string; content: JsonContent<z.ZodType<ErrorBody>> };

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
  readonly json?: z.ZodType;
};

type DeclaredRequest<Request extends RequestSchemas> = (Request["query"] extends z.ZodType
  ? { query: Request["query"] }
  : {}) &
  (Request["params"] extends z.ZodType ? { params: Request["params"] } : {}) &
  (Request["json"] extends z.ZodType
    ? { body: { required: true; content: JsonContent<Request["json"]> } }
    : {});

type BaseStatuses<Role extends RouteRole, Request extends RequestSchemas> =
  | 500
  | 503
  | (Role extends "public" ? never : 401 | 403)
  | (keyof Request extends never ? never : 400)
  | (Request["json"] extends z.ZodType ? 415 : never);

type DeclaredResponses<
  Reply extends z.ZodType,
  Success extends SuccessStatus,
  Statuses extends ErrorStatus,
> = { [Status in Success]: { description: string; content: JsonContent<Reply> } } & {
  [Status in Statuses]: ErrorResponse;
};

interface Declaration<
  Path extends string,
  Role extends RouteRole,
  Request extends RequestSchemas,
  Reply extends z.ZodType,
  Success extends SuccessStatus,
  Own extends Partial<Record<ErrorStatus, readonly string[]>>,
> {
  readonly method: "get" | "post" | "delete";
  readonly path: Path;
  readonly tag: RouteTag;
  readonly summary: string;
  readonly role: Role;
  readonly request?: Request;
  readonly reply: Reply;
  readonly status?: Success;
  readonly errors?: Own;
}

function errorSchema(codes: readonly string[]): z.ZodType<ErrorBody> {
  return z.object({
    error: z
      .object({ code: z.enum(codes as [string, ...string[]]), message: z.string() })
      .catchall(z.unknown()),
  }) as z.ZodType<ErrorBody>;
}

function declaredErrors(
  role: RouteRole,
  request: RequestSchemas,
  own: Partial<Record<ErrorStatus, readonly string[]>>,
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
  if (request.json !== undefined) add(415, BASE_CODES[415]);
  add(500, BASE_CODES[500]);
  add(503, BASE_CODES[503]);
  return Object.fromEntries(
    [...codes].map(([status, list]) => [
      status,
      {
        description: `Error codes: ${list.join(", ")}.`,
        content: { "application/json": { schema: errorSchema(list) } },
      },
    ]),
  );
}

export function declareRoute<
  const Path extends string,
  const Role extends RouteRole,
  const Request extends RequestSchemas = {},
  const Reply extends z.ZodType = z.ZodType,
  const Success extends SuccessStatus = 200,
  const Own extends Partial<Record<ErrorStatus, readonly string[]>> = {},
>(declaration: Declaration<Path, Role, Request, Reply, Success, Own>) {
  const request: RequestSchemas = declaration.request ?? {};
  const success = declaration.status ?? 200;
  const body = request.json;
  const responses = {
    [success]: {
      description: "Success",
      content: { "application/json": { schema: declaration.reply } },
    },
    ...declaredErrors(declaration.role, request, declaration.errors ?? {}),
  } as DeclaredResponses<Reply, Success, (keyof Own & ErrorStatus) | BaseStatuses<Role, Request>>;
  return createRoute({
    method: declaration.method,
    path: declaration.path,
    tags: [declaration.tag],
    summary: declaration.summary,
    description: `Role: ${declaration.role === "public" ? "none, no token needed" : declaration.role}.`,
    security: declaration.role === "public" ? [] : [{ [BEARER_SCHEME]: [] }],
    request: {
      ...(request.query === undefined ? {} : { query: request.query }),
      ...(request.params === undefined ? {} : { params: request.params }),
      ...(body === undefined
        ? {}
        : { body: { required: true, content: { "application/json": { schema: body } } } }),
    } as DeclaredRequest<Request>,
    responses,
  });
}

export function validationHook(
  result: { success: true } | { success: false; error: z.ZodError },
  c: Context,
): Response | undefined {
  if (result.success) return undefined;
  return errorResponse(c, badRequest(describeSchemaIssues(result.error.issues)));
}
