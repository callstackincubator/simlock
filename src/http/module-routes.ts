import { type OpenAPIHono, z } from "@hono/zod-openapi";

import type { ModuleHttpResponse, OptionalModuleDefinition } from "../modules/index.js";
import { BEARER_SCHEME } from "./routes.js";

function errorBody(codes: readonly string[]) {
  return z.object({
    error: z
      .object({ code: z.enum(codes as [string, ...string[]]), message: z.string() })
      .catchall(z.unknown()),
  });
}

// why: a module's mount sits behind agentAuth (ADR 0030), so 401 and 403 are the same for every module route.
const AUTH_STATUSES: Readonly<Record<number, ModuleHttpResponse>> = {
  401: { description: "No valid token.", errorCodes: ["UNAUTHENTICATED"] },
  403: { description: "The token's role may not do this.", errorCodes: ["FORBIDDEN"] },
};

function responseOf(response: ModuleHttpResponse) {
  const { description, contentTypes, errorCodes, headers } = response;
  const content =
    errorCodes === undefined
      ? Object.fromEntries(
          (contentTypes ?? []).map((type) => [
            type,
            { schema: z.string().openapi({ format: "binary" }) },
          ]),
        )
      : { "application/json": { schema: errorBody(errorCodes) } };
  return {
    description,
    ...(Object.keys(content).length === 0 ? {} : { content }),
    ...(headers === undefined
      ? {}
      : {
          headers: z.object(
            Object.fromEntries(
              Object.entries(headers).map(([name, text]) => [name, z.string().describe(text)]),
            ),
          ),
        }),
  };
}

type RouteConfig = Parameters<OpenAPIHono["openAPIRegistry"]["registerPath"]>[0];

export function moduleRoutes(
  definitions: readonly OptionalModuleDefinition<unknown>[],
): readonly RouteConfig[] {
  return definitions.flatMap((definition) =>
    (definition.http?.routes ?? []).map((route) => {
      const params = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
      return {
        method: route.method,
        path: route.path,
        tags: [definition.name],
        description: route.description,
        security: [{ [BEARER_SCHEME]: [] }],
        request: {
          params: z.object(Object.fromEntries(params.map((name) => [name, z.string()]))),
        },
        responses: Object.fromEntries(
          Object.entries({ ...AUTH_STATUSES, ...route.statuses }).map(([status, response]) => [
            status,
            responseOf(response),
          ]),
        ),
      } as RouteConfig;
    }),
  );
}
