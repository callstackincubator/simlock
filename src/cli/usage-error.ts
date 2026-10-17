export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function withHelpHint(message: string): string {
  return `${message} (run \`simlock --help\` for usage)`;
}
