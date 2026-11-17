import { z } from "zod";

export const deviceModeSchema = z.enum(["slim", "full"]);

export const leaseIdentitySchema = z.enum(["reusable", "fresh"]);

// why: \p{Cc} is exactly U+0000-U+001F and U+007F-U+009F, the spec's control characters.
export const CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/gu;
