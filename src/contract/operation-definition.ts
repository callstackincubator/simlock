import { z } from "zod";
import { type AuthorizeContext, type Role } from "./roles.js";

export type Effect = "read" | "write";

export interface OperationDefinition<
  Name extends string = string,
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: Name;
  readonly role: Role | ((input: z.infer<InputSchema>) => Role);
  readonly effect: Effect | ((input: z.infer<InputSchema>) => Effect);
  readonly input: InputSchema;
  readonly output: OutputSchema;
  readonly authorize?: (input: z.infer<InputSchema>, context: AuthorizeContext) => boolean;
}

export function defineOperation<
  Name extends string,
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
>(
  definition: OperationDefinition<Name, InputSchema, OutputSchema>,
): OperationDefinition<Name, InputSchema, OutputSchema> {
  return definition;
}

/**
 * why: `device.exec`'s and `device.rotate`'s one rule, so a gateway's admin session is held to the lease's requester on both.
 */
export function authorizeOneLeaseCall(
  input: { readonly leaseId: string; readonly requesterId?: string | undefined },
  context: AuthorizeContext,
): boolean {
  if (context.role !== "admin") {
    if (input.requesterId !== undefined) return false;
    const ownerId = context.ownerId(input.leaseId);
    return ownerId === undefined || ownerId === context.principal;
  }
  const requesterId = input.requesterId ?? context.principal;
  const leaseRequesterId = context.leaseRequesterId(input.leaseId);
  return leaseRequesterId === undefined || leaseRequesterId === requesterId;
}
