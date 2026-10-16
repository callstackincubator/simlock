export interface AgentDeviceHealthProbe {
  read(baseUrl: string): Promise<unknown>;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

export class NodeAgentDeviceHealthProbe implements AgentDeviceHealthProbe {
  constructor(readonly timeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS) {}

  async read(baseUrl: string): Promise<unknown> {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return (await response.json()) as unknown;
  }
}
