import { randomUUID } from "node:crypto";

export interface IdGenerator {
  generate(): string;
}

export class CryptoIdGenerator implements IdGenerator {
  generate(): string {
    return randomUUID();
  }
}
