export type TokenRole = "agent" | "operator" | "worker";

export interface TokenRecord {
  readonly id: string;
  readonly hash: string;
  readonly role: TokenRole;
  readonly label?: string;
  readonly createdAt: number;
}

export interface TokenOperations {
  create(role: TokenRole, label?: string): Promise<{ record: TokenRecord; secret: string }>;
  list(): Promise<TokenRecord[]>;
  revoke(id: string): Promise<boolean>;
  verify(secret: string): Promise<TokenRecord | undefined>;
}
