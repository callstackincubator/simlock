import type { Identity } from "../../auth/index.js";
import type { ModuleRegistryView } from "../../modules/index.js";
import type { AgentDevicePlatform } from "../host/agent-device-supervisor.js";
import type { AgentDeviceHost } from "../host/host.js";
import { FRONT_PREFIX } from "../shared/paths.js";
import { frontReplyFor, notAvailable } from "../shared/replies.js";
import { classifyCall, readRpcBody } from "../shared/rpc.js";

export type LinkStatus =
  | {
      readonly state: "running";
      // why: a link that serves many hosts names the ceiling only for a lease it can place; the front reads it from `status(leaseId)`.
      readonly leaseMaxTtlMs?: number;
      readonly platforms: readonly AgentDevicePlatform[];
    }
  | { readonly state: "unavailable"; readonly reason: string }
  // why: the lease may still exist, but only its worker can say, and the worker is not connected or not yet read.
  | { readonly state: "unreachable" };

// why: a lease the front may rebuild an entry for after a gateway restart, with what the entry needs.
export interface AdoptableLease {
  readonly leaseId: string;
  readonly address: string;
  readonly platform: "ios" | "android";
  readonly model: string;
  readonly target: string;
  readonly ttlMs: number;
  readonly ttlDeadline: number;
}

export interface HostLink {
  // why: only a link that serves many hosts routes non-RPC requests by the lease header and fans out `devices`; the gateway's link and a worker's routed link do.
  readonly readsLeaseHeader: boolean;
  // why: capabilities a lease request must require so it lands on a host that can serve agent-device; none means any worker.
  readonly leaseRequires?: readonly string[];
  status(leaseId?: string, identity?: Identity): Promise<LinkStatus>;
  forward(request: Request, identity: Identity, leaseId?: string): Promise<Response>;
  // why: only the gateway's link adopts leases made before the front's map was empty; a worker's map is in memory and has no entry for a lease it made before a restart, but that lease is ended, not adopted.
  adoptable?(identity: Identity): readonly AdoptableLease[];
  // why: a lease the front asked for in this process is its allocate's to keep or release, never to adopt.
  asked?(leaseId: string): void;
  // why: only a link that serves many hosts can tell a lease its list left out for a moment from one the host ended; a worker's list is the source, so a lease missing there is final.
  stillHeld?(leaseId: string): boolean;
  dispose?(): void;
}

interface RoutedHosts {
  readonly simulators: AgentDeviceHost;
  readonly phones: AgentDeviceHost;
}

type Role = keyof RoutedHosts;

// why: a client reads `/health` before it names a lease, so it pins the simulator daemon's proxy and daemon ids; the phone daemon's differ and would refuse every phone call, so a phone call carries no pin and a phone-daemon restart ends the lease at its next heartbeat, as a simulator-daemon restart does.
function dropInstancePins(request: Request): void {
  request.headers.delete("x-agent-device-instance");
  request.headers.delete("x-agent-device-upstream-instance");
}

// why: a worker runs one agent-device daemon for simulators and one for phones; this link holds a host for each and remembers which daemon each lease was allocated on.
export class RoutedHostLink implements HostLink {
  readonly readsLeaseHeader = true;
  readonly #roles = new Map<string, Role>();

  constructor(
    private readonly hosts: RoutedHosts,
    private readonly registry: ModuleRegistryView,
  ) {}

  async status(leaseId?: string): Promise<LinkStatus> {
    const role = leaseId === undefined ? undefined : this.#roles.get(leaseId);
    if (role !== "phones") return this.hosts.simulators.status();
    return this.#phoneStatus();
  }

  async forward(request: Request, identity: Identity, leaseId?: string): Promise<Response> {
    const role = await this.#roleOf(request, leaseId);
    if (role === "phones") {
      const status = await this.#phoneStatus();
      if (status.state === "unavailable") {
        return frontReplyFor(request, notAvailable(status.reason));
      }
      dropInstancePins(request);
    }
    return this.hosts[role].forward(request, identity);
  }

  // why: a lease that ended no longer needs its daemon remembered, and the map holds only live phone leases.
  forget(leaseId: string): void {
    this.#roles.delete(leaseId);
  }

  // why: the phone daemon's reason is named with its role, so an agent can tell it from the simulator daemon's.
  async #phoneStatus(): Promise<LinkStatus> {
    const status = await this.hosts.phones.status();
    return status.state === "unavailable"
      ? { reason: `phone daemon: ${status.reason}`, state: "unavailable" }
      : status;
  }

  async #roleOf(request: Request, leaseId: string | undefined): Promise<Role> {
    const known = leaseId === undefined ? undefined : this.#roles.get(leaseId);
    if (known !== undefined) return known;
    if (!(await this.#allocatesPhone(request))) return "simulators";
    if (leaseId !== undefined) this.#roles.set(leaseId, "phones");
    return "phones";
  }

  async #allocatesPhone(request: Request): Promise<boolean> {
    if (request.method !== "POST" || new URL(request.url).pathname !== `${FRONT_PREFIX}/rpc`) {
      return false;
    }
    const read = await readRpcBody(request.clone());
    if (read.kind !== "request" || classifyCall(read.method, read.params) !== "allocate") {
      return false;
    }
    const address = read.params["serial"] ?? read.params["udid"];
    return this.registry.snapshot.devices.some(
      (device) => device.physical && device.driverDeviceId === address,
    );
  }
}
