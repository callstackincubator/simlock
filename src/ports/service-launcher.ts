import { homedir } from "node:os";
import { join } from "node:path";

import {
  type DaemonExit,
  type DaemonLauncher,
  logReaderSince,
  NodeDaemonLauncher,
} from "./daemon-launcher.js";
import type { DaemonRole } from "./paths.js";
import { serviceDefinition, type ServiceManager } from "./service-manager.js";

export interface LauncherForOptions {
  readonly role: DaemonRole;
  readonly root: string;
  readonly dataDirectory: string;
  readonly mainPath: string;
  readonly serviceManager: ServiceManager | undefined;
  readonly notify: (line: string) => void;
  readonly nodePath?: string;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawner?: DaemonLauncher;
}

export function launcherFor(options: LauncherForOptions): DaemonLauncher {
  const spawner =
    options.spawner ??
    new NodeDaemonLauncher({
      args: [options.mainPath, ...(options.role === "gateway" ? ["--gateway"] : [])],
      command: options.nodePath ?? process.execPath,
      logPath: join(options.dataDirectory, "daemon.log"),
      simlockHome: options.root,
    });
  const { serviceManager } = options;
  if (serviceManager === undefined) return spawner;
  const definition = serviceDefinition({
    role: options.role,
    root: options.root,
    dataDirectory: options.dataDirectory,
    home: options.home ?? homedir(),
    nodePath: options.nodePath ?? process.execPath,
    mainPath: options.mainPath,
    env: options.env ?? process.env,
  });
  return {
    launch: async () => {
      const state = await serviceManager.state(definition);
      if (state.state === "not-loaded") {
        options.notify(`Service ${definition.name} is not loaded; started the daemon without it.`);
      }
      if (state.state === "broken") {
        const paths = state.missing.join(", ");
        const verb = state.missing.length === 1 ? "is" : "are";
        options.notify(
          `Service ${definition.name} is broken (${paths} ${verb} gone); started the daemon without it. Run simlock daemon install again.`,
        );
      }
      if (state.state !== "installed") return spawner.launch();
      const readOutput = await logReaderSince(join(options.dataDirectory, "daemon.log"));
      await serviceManager.start(definition);
      return { exited: new Promise<DaemonExit>(() => undefined), readOutput };
    },
  };
}
