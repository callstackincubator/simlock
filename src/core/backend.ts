import type { EventMap } from "../bus/index.js";
import type {
  BytePipeLauncher,
  Clock,
  Filesystem,
  HttpJsonRequester,
  IdGenerator,
  Logger,
  ProcessRunner,
  ProcessSupervisor,
  SqliteDatabase,
  TcpListenerFactory,
  TcpProbe,
  TcpStreamConnector,
  WebSocketClientConnector,
} from "../ports/index.js";
import type { DriverConfigEntry } from "./config.js";
import type { DeviceDataTable, Driver, PrerequisiteCheck } from "./driver.js";
import type { Validator } from "./validation.js";

export type BackendSettings = Readonly<Record<string, string | number | boolean>>;

export interface BackendCapabilities {
  readonly baselines: boolean;
  readonly physical: boolean;
  readonly except: boolean;
}

export interface BackendDefinition<
  Settings = BackendSettings,
  RuntimeConfig = unknown,
> extends DriverConfigEntry<RuntimeConfig> {
  readonly id: string;
  readonly settings: {
    readonly defaults: Settings;
    readonly validators: Readonly<Record<string, Validator>>;
  };
  readonly capabilities: BackendCapabilities;
}

export type BackendDiagnostic = {
  [Name in keyof EventMap]: {
    readonly event: Name;
    readonly payload: EventMap[Name];
  };
}[keyof EventMap];

export interface BackendContext<Settings = BackendSettings, RuntimeConfig = unknown> {
  readonly settings: Settings;
  readonly configuration: RuntimeConfig;
  readonly clock: Clock;
  readonly database: SqliteDatabase;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly filesystem: Filesystem;
  readonly http: HttpJsonRequester;
  readonly webSockets: WebSocketClientConnector;
  readonly processRunner: ProcessRunner;
  readonly processSupervisor: ProcessSupervisor;
  readonly tcp: {
    readonly listener: TcpListenerFactory;
    readonly probe: TcpProbe;
    readonly connector: TcpStreamConnector;
  };
  readonly idGenerator: IdGenerator;
  readonly instanceId: string;
  readonly simlockHome: string;
  readonly homeDirectory: string;
  readonly hostArch: string;
  readonly hostPlatform: NodeJS.Platform;
  readonly logger: Logger;
  readonly acceptAndroidLicenses: boolean;
  readonly slimByDefault?: boolean;
  readonly pid: number;
  readonly uid?: number;
  readonly onDiagnostic: (diagnostic: BackendDiagnostic) => void;
  readonly capture: {
    readonly launcher: BytePipeLauncher;
    readonly iosCommand: string;
    readonly iosDeviceCommand: string;
    readonly scrcpyServerPath: string;
  };
}

export interface BackendModule<Settings = BackendSettings, RuntimeConfig = unknown> {
  readonly definition: BackendDefinition<Settings, RuntimeConfig>;
  readonly deviceDataTable: DeviceDataTable;
  prerequisites(context: BackendContext<Settings, RuntimeConfig>): PrerequisiteCheck;
  create(context: BackendContext<Settings, RuntimeConfig>): Promise<Driver>;
}
