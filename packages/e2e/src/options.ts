export interface SimlockDevicesOptions {
  url: string;
  token: string;
  platform: "ios" | "android";
  device: string;
  osVersion?: string | undefined;
  imageTag?: string | undefined;
  deviceMode?: "slim" | "full" | undefined;
  deviceBaseline?: string | undefined;
  extraApps?: readonly string[] | undefined;
  ttlMs?: number | undefined;
  queueMs?: number | undefined;
  installConcurrency?: number | undefined;
}

export interface ProviderOptions {
  url: string;
  token: string;
  platform: "ios" | "android";
  device: string;
  osVersion?: string;
  imageTag?: string;
  deviceMode?: "slim" | "full";
  deviceBaseline?: string;
  extraApps: readonly string[];
  ttlMs: number;
  queueMs: number;
  installConcurrency: number;
}
