import type { Role } from "../contract/index.js";

export interface SessionRoleResolver {
  resolve(hello: {
    readonly principal?: string;
    readonly credential?: string;
  }): Promise<Role> | Role;
}

export const resolveAgentRole: SessionRoleResolver = {
  resolve: () => "agent",
};

export class AdminAuthenticationFailedError extends Error {
  constructor() {
    super("Invalid admin credential");
    this.name = "AdminAuthenticationFailedError";
  }
}
