import {
  invalidValue,
  nonEmptyString,
  positiveNumber,
  type BackendDefinition,
} from "../../../core/index.js";
import { cloudOrigin } from "./origin.js";

export const ADC_ADB_SERVER_PORT = 5039;

export type AdcSettings = Readonly<{
  apiUrl: string;
  apiKeyEnv: string;
  adbServerPort: number;
  provisionTimeoutMs: number;
  deviceRoot?: string;
}>;

function adbPort(value: unknown, path: string): number {
  const port = positiveNumber(value, path);
  const integer = Number.isInteger(port);
  if (integer === false || port === 5037 || port > 65535) {
    throw invalidValue(path, "a TCP port other than the shared ADB port 5037");
  }
  return port;
}

function apiOrigin(value: unknown, path: string): string {
  const text = nonEmptyString(value, path);
  try {
    return cloudOrigin(text);
  } catch {
    throw invalidValue(path, "an HTTPS origin, or HTTP on localhost");
  }
}

export const androidAdcDefinition: BackendDefinition<AdcSettings> = {
  id: "adc",
  platform: "android",
  defaults: {},
  validators: {},
  settings: {
    defaults: {
      apiUrl: "https://api.agentdevicecloud.xyz",
      apiKeyEnv: "ADC_API_KEY",
      adbServerPort: ADC_ADB_SERVER_PORT,
      provisionTimeoutMs: 600_000,
    },
    validators: {
      apiUrl: apiOrigin,
      apiKeyEnv: nonEmptyString,
      adbServerPort: adbPort,
      provisionTimeoutMs: positiveNumber,
      deviceRoot: nonEmptyString,
    },
  },
  capabilities: { baselines: false, physical: false, except: false },
};
