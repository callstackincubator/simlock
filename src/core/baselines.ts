import type { BaselineEntry } from "../contract/index.js";

export interface BaselineSaveRequest {
  readonly leaseId: string;
  readonly name: string;
  readonly note?: string | undefined;
  readonly requesterId: string;
}

export interface BaselineSaveResult {
  readonly baseline: BaselineEntry;
  readonly leaseId: string;
}

export class BaselineService {
  async save(_request: BaselineSaveRequest): Promise<BaselineSaveResult> {
    return {
      baseline: {
        mode: "full",
        model: "",
        name: "unsaved",
        osVersion: "",
        platform: "ios",
        savedAt: "",
        version: 1,
      },
      leaseId: "unsaved",
    };
  }
}
