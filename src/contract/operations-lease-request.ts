import { z } from "zod";
import { defineOperation } from "./operation-definition.js";
import { parseOsConstraint } from "./os-range.js";
import {
  baselineNameSchema,
  capabilityNameSchema,
  type DeviceClass,
  deviceClassSchema,
  EXCEPT_MAX_NAMES,
  EXCEPT_NAME_PATTERN,
  imageTagSchema,
  leaseGrantSchema,
  platformSchema,
  requesterIdSchema,
  WARM_POOL_NAME_MAX,
} from "./schemas.js";

/**
 * The lease ID a requester may choose (ADR 0020 §1): ASCII, 1 to 64 characters, starting with a
 * letter or digit, then letters, digits, `-` and `_`, case-sensitive. It has no `.`, so it can
 * never look like a gateway's `<worker>.<lease ID>`. The one definition: a gateway reads it too,
 * to decide which reported lease it names bare.
 */
export const LEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const leaseIdSchema = z.string().regex(LEASE_ID_PATTERN);

/**
 * why: a component's version (`26.4`, `35`) reaches the driver unread and becomes an installer
 * argument, so its shape is bounded here (safety rule 10): no whitespace or control character, no
 * `;` (sdkmanager's package path separator), no leading `-` (an option). An exact `osVersion` in
 * `lease.request` is held to it too, because a downloadable missing runtime installs that string.
 */
export const componentVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^\s\p{Cc};]+$/u, "must contain no whitespace, control character or ';'")
  .refine((version) => !version.startsWith("-"), "must not start with '-'");

const EXACT_OS_VERSION_BOUND =
  "an exact OS version is 1 to 64 characters, none of them whitespace, a control character or `;`, and does not start with `-`";

const leaseRequestBaseSchema = z
  .object({
    model: z.string().min(1).max(WARM_POOL_NAME_MAX).optional(),
    class: deviceClassSchema.optional(),
    platform: platformSchema,
    // why: A plain string, checked by `refuseBadOsVersion`: a refined field would be checked by the MCP SDK
    // before the handler, and its error would stand in for `BAD_REQUEST`.
    osVersion: z.string().optional(),
    mode: z.enum(["slim", "full"]).optional(),
    // why: A plain array of plain strings, bounded by `refuseBadExcept` as the one object-level check, like `osVersion`: a bound on the field itself would be checked by the MCP SDK before the handler.
    except: z.array(z.string()).optional(),
    imageTag: imageTagSchema.optional(),
    baseline: baselineNameSchema.optional(),
    physical: z.boolean().optional(),
    requesterId: requesterIdSchema.optional(),
    allowDownload: z.boolean().optional(),
    noWait: z.boolean().optional(),
    timeoutMs: z.number().finite().positive().optional(),
    /** why: Capped by the dispatcher's handler, not here: the cap is daemon config this module cannot see. */
    ttlMs: z.number().finite().positive().optional(),
    owner: z.string().optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    // why: A plain string, bounded by `refuseBadRunId` as the one object-level check, like `osVersion`: a refined field would be checked by the MCP SDK before the handler.
    runId: z.string().optional(),
    // why: A plain string, bounded by `refuseBadLabel` as the one object-level check, like `runId`: a refined field would be checked by the MCP SDK before the handler.
    label: z.string().optional(),
    leaseId: leaseIdSchema.optional(),
    fleetRequestId: z.string().min(1).max(200).optional(),
    // why: A plain record of plain strings, bounded by `refuseBadMetadata` as one object-level check, like `except`: a bound on the field itself would be checked by the MCP SDK before the handler.
    metadata: z.record(z.string(), z.string()).optional(),
    requires: z
      .array(capabilityNameSchema)
      .max(8)
      .refine((names) => new Set(names).size === names.length, "a capability name appears twice")
      .optional(),
  })
  .strict();

export function refuseModelWithClass(
  modelField = "model",
): <T extends { readonly model?: unknown; readonly class?: unknown }>(
  input: T,
  context: z.RefinementCtx,
) => void {
  return (input, context) => {
    if (input.model !== undefined && input.class !== undefined) {
      context.addIssue({
        code: "custom",
        message: `a request names a model or a class, not both: send only one of \`${modelField}\` and \`class\``,
        path: ["class"],
      });
    }
  };
}

function refuseBaselineWithClass(): <
  T extends { readonly baseline?: unknown; readonly class?: unknown },
>(
  input: T,
  context: z.RefinementCtx,
) => void {
  return (input, context) => {
    if (input.baseline !== undefined && input.class !== undefined) {
      context.addIssue({
        code: "custom",
        message:
          "a request names a baseline or a class, not both: send only one of `baseline` and `class`",
        path: ["class"],
      });
    }
  };
}

/** why: `allowDownload: false` passes because the CLI always sends it. */
function refusePhysicalWithImageFields(): <
  T extends {
    readonly physical?: boolean | undefined;
    readonly mode?: unknown;
    readonly imageTag?: unknown;
    readonly baseline?: unknown;
    readonly allowDownload?: boolean | undefined;
  },
>(
  input: T,
  context: z.RefinementCtx,
) => void {
  return (input, context) => {
    if (input.physical !== true) return;
    const refused = [
      input.mode === undefined ? undefined : "mode",
      input.imageTag === undefined ? undefined : "imageTag",
      input.baseline === undefined ? undefined : "baseline",
      input.allowDownload === true ? "allowDownload" : undefined,
    ];
    for (const field of refused) {
      if (field === undefined) continue;
      context.addIssue({
        code: "custom",
        message: `\`${field}\` has no meaning for a physical device`,
        path: [field],
      });
    }
  };
}

/** why: one object-level check with no path (like `osVersion`), so every transport, MCP included, answers `BAD_REQUEST` with the message as written. */
function refuseBadExcept(): <
  T extends {
    readonly except?: readonly string[] | undefined;
    readonly mode?: unknown;
    readonly physical?: boolean | undefined;
    readonly platform: string;
  },
>(
  input: T,
  context: z.RefinementCtx,
) => void {
  return (input, context) => {
    const { except } = input;
    if (except === undefined) return;
    const message = exceptRefusal(input, except);
    if (message !== undefined) context.addIssue({ code: "custom", message });
  };
}

function exceptRefusal(
  input: {
    readonly mode?: unknown;
    readonly physical?: boolean | undefined;
    readonly platform: string;
  },
  except: readonly string[],
): string | undefined {
  if (except.length < 1 || except.length > EXCEPT_MAX_NAMES) {
    return `except names 1 to ${EXCEPT_MAX_NAMES} categories`;
  }
  const bad = except.find((name) => !EXCEPT_NAME_PATTERN.test(name));
  if (bad !== undefined) return `except: "${bad}" is not a category name`;
  const twice = except.find((name, index) => except.indexOf(name) !== index);
  if (twice !== undefined) return `except names "${twice}" twice`;
  if (input.physical === true || input.platform !== "ios") return "except is for iOS simulators";
  if (input.mode === "full") return "except needs a slim lease (mode is full)";
  return undefined;
}

const METADATA_MAX_KEYS = 16;
const METADATA_KEY_MAX = 64;
const METADATA_VALUE_MAX = 256;
const METADATA_TOTAL_MAX = 2048;

function metadataRefusal(metadata: Readonly<Record<string, string>>): string | undefined {
  const entries = Object.entries(metadata);
  if (entries.length > METADATA_MAX_KEYS) return `metadata has more than ${METADATA_MAX_KEYS} keys`;
  const badKey = entries.find(([key]) => key.length < 1 || key.length > METADATA_KEY_MAX);
  if (badKey !== undefined) {
    return `metadata key must be 1 to ${METADATA_KEY_MAX} characters (got ${badKey[0]})`;
  }
  const badValue = entries.find(([, value]) => value.length > METADATA_VALUE_MAX);
  if (badValue !== undefined) {
    return `metadata value for ${badValue[0]} must be at most ${METADATA_VALUE_MAX} characters`;
  }
  const total = entries.reduce((sum, [key, value]) => sum + key.length + value.length, 0);
  if (total > METADATA_TOTAL_MAX)
    return `metadata is longer than ${METADATA_TOTAL_MAX} characters in all`;
  return undefined;
}

function refuseBadMetadata(): <
  T extends { readonly metadata?: Readonly<Record<string, string>> | undefined },
>(
  input: T,
  context: z.RefinementCtx,
) => void {
  return (input, context) => {
    if (input.metadata === undefined) return;
    const message = metadataRefusal(input.metadata);
    if (message !== undefined) context.addIssue({ code: "custom", message });
  };
}

/** why: the CLI checks a run id against it before connecting, so a bad `SIMLOCK_RUN` fails before a lease waits. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

const RUN_ID_REFUSAL = "a run id is 1 to 128 letters, digits, `.`, `_` or `-`";

export function refuseBadRunId(): <T extends { readonly runId?: string | undefined }>(
  input: T,
  context: z.RefinementCtx,
) => void {
  return (input, context) => {
    if (input.runId === undefined || RUN_ID_PATTERN.test(input.runId)) return;
    context.addIssue({ code: "custom", message: RUN_ID_REFUSAL });
  };
}

const LABEL_LENGTH_REFUSAL = "label must be 1 to 64 characters";
const LABEL_CONTROL_REFUSAL = "label must not contain control characters";

export function refuseBadLabel(): <T extends { readonly label?: string | undefined }>(
  input: T,
  context: z.RefinementCtx,
) => void {
  return (input, context) => {
    const { label } = input;
    if (label === undefined) return;
    if (label.length < 1 || label.length > 64) {
      context.addIssue({ code: "custom", message: LABEL_LENGTH_REFUSAL });
    } else if (/[\p{Cc}\u2028\u2029]/u.test(label)) {
      context.addIssue({ code: "custom", message: LABEL_CONTROL_REFUSAL });
    }
  };
}

export function refuseBadOsVersion(): <T extends { readonly osVersion?: string | undefined }>(
  input: T,
  context: z.RefinementCtx,
) => void {
  return (input, context) => {
    if (input.osVersion === undefined) return;
    const parsed = parseOsConstraint(input.osVersion);
    if (!parsed.ok) {
      context.addIssue({
        code: "custom",
        message: parsed.message,
        path: ["osVersion"],
      });
      return;
    }
    if (
      parsed.constraint.kind === "exact" &&
      !componentVersionSchema.safeParse(parsed.constraint.version).success
    ) {
      context.addIssue({
        code: "custom",
        message: EXACT_OS_VERSION_BOUND,
        path: ["osVersion"],
      });
    }
  };
}

export const leaseRequestFields = leaseRequestBaseSchema;

const leaseRequestInputSchema = leaseRequestBaseSchema
  .superRefine(refuseModelWithClass())
  .superRefine(refuseBaselineWithClass())
  .superRefine(refuseBadOsVersion())
  .superRefine(refuseBadExcept())
  .superRefine(refuseBadMetadata())
  .superRefine(refuseBadRunId())
  .superRefine(refuseBadLabel())
  .superRefine(refusePhysicalWithImageFields());

export const leaseRequest = defineOperation({
  name: "lease.request",
  role: "agent",
  effect: "write",
  input: leaseRequestInputSchema,
  output: leaseGrantSchema,
  // why: No `authorize` hook on purpose: any agent session may request under an arbitrary
  // `requesterId` (printable, at most 256 characters), and `owner` is gated by role in the handler (the resource does not exist yet).
});

export function requestedDevice(
  input: Omit<z.infer<typeof leaseRequestInputSchema>, "except"> & {
    readonly except?: readonly string[] | undefined;
  },
) {
  return {
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.class === undefined ? {} : { class: input.class }),
    platform: input.platform,
    ...(input.osVersion === undefined ? {} : { osVersion: input.osVersion }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.except === undefined ? {} : { except: [...input.except] }),
    ...(input.imageTag === undefined ? {} : { imageTag: input.imageTag }),
    ...(input.baseline === undefined ? {} : { baseline: input.baseline }),
    ...(input.physical === true ? { physical: true as const } : {}),
  };
}

export function requestedClass(request: {
  readonly model?: undefined;
  readonly class?: DeviceClass | undefined;
}): DeviceClass;
export function requestedClass(request: {
  readonly model?: string | undefined;
  readonly class?: DeviceClass | undefined;
}): DeviceClass | undefined;
export function requestedClass(request: {
  readonly model?: string | undefined;
  readonly class?: DeviceClass | undefined;
}): DeviceClass | undefined {
  if (request.class !== undefined) return request.class;
  return request.model === undefined ? "phone" : undefined;
}
