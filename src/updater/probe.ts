import { connectSimlockAdmin } from "../admin/index.js";
import {
  NodeIpcTransport,
  IpcError,
  resolveDaemonSocketPath,
  type Filesystem,
  type IpcConnector,
} from "../ports/index.js";
import type { DaemonProbe } from "./index.js";

export interface DaemonProbeOptions {
  readonly dataDirectory: string;
  readonly filesystem: Filesystem;
  readonly ipc?: IpcConnector;
}

// why: the admin client is the only way the updater talks to the daemon, as any CLI does.
export function createDaemonProbe(options: DaemonProbeOptions): DaemonProbe {
  const { dataDirectory, filesystem } = options;
  const endpoint = resolveDaemonSocketPath(dataDirectory);
  const ipc = options.ipc ?? new NodeIpcTransport();
  const connect = async (): Promise<Awaited<ReturnType<typeof connectSimlockAdmin>>> => {
    const credential = (await filesystem.readFile(`${dataDirectory}/admin.token`)).trim();
    return connectSimlockAdmin({ endpoint, ipc, credential });
  };
  const use = async <T>(
    work: (client: Awaited<ReturnType<typeof connectSimlockAdmin>>) => Promise<T>,
  ): Promise<T> => {
    const client = await connect();
    try {
      return await work(client);
    } finally {
      await client.close();
    }
  };
  return {
    stop: () =>
      use(async (client) => {
        await client.stopDaemon();
      }),
    // why: a socket file outlives its daemon and a stopping daemon accepts then closes connections, so only a refused or missing endpoint proves no daemon holds it; any other failure cannot prove it.
    listening: async () => {
      try {
        await (await ipc.connect(endpoint)).close();
        return true;
      } catch (error: unknown) {
        if (!(error instanceof IpcError)) return true;
        return error.code !== "connection-refused" && error.code !== "endpoint-not-found";
      }
    },
    state: async () => {
      try {
        return await use(async (client) => {
          const status = await client.getStatus();
          return { health: status.daemon.health, version: client.daemonVersion };
        });
      } catch {
        return undefined;
      }
    },
  };
}
