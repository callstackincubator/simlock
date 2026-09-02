import { createHash, randomBytes } from "node:crypto";

export interface TokenSecrets {
  generateSecret(): string;
  hash(secret: string): string;
}

const SECRET_PREFIX = "slk_";
const SECRET_ENTROPY_BYTES = 32;

export class CryptoTokenSecrets implements TokenSecrets {
  generateSecret(): string {
    return `${SECRET_PREFIX}${randomBytes(SECRET_ENTROPY_BYTES).toString("base64url")}`;
  }

  hash(secret: string): string {
    return createHash("sha256").update(secret).digest("hex");
  }
}
