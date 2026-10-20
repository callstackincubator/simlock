import type { AlertFormatName } from "../../core/index.js";
import { genericFormat } from "./generic/index.js";
import type { AlertFormatDefinition } from "./types.js";

export const ALERT_FORMAT_REGISTRY: { readonly [N in AlertFormatName]: AlertFormatDefinition } = {
  generic: genericFormat,
};
