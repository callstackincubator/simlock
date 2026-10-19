export interface Identity {
  readonly principal: string;
  readonly name: string;
  readonly role: "operator" | "agent";
  readonly via: string;
  readonly expiresAt?: number;
  readonly ambient: boolean;
  readonly signOutUrl?: string;
}
