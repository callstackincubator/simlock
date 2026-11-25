import type { Role } from "../contract/index.js";

export interface StreamCaller {
  readonly principal: string;
  readonly role: Role;
}
