import { createServer } from "node:net";

export const LANE_PORTS = [4180, 5556, 4700] as const;

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export async function assertLanePortsFree(): Promise<void> {
  for (const port of LANE_PORTS) {
    if (!(await isFree(port))) {
      throw new Error(`port ${port} is in use; the real-proxy lane needs it free`);
    }
  }
}
