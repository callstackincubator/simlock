import type { ReactNode } from "react";

import { ApiError } from "../api";
import { Id, PageHeader, Panel, StatCards } from "../layout";
import { useLiveResource, useNow } from "../live/live-context";
import { Loaded } from "../live/route-state";
import { formatDuration } from "../live/time";
import { Link, usePath } from "../router";
import {
  deviceOfLease,
  type Holder,
  holderOf,
  type LeaseDetails,
  leaseIdFrom,
  type LeaseList,
  leasePath,
  type LeaseRecord,
  leasesOnWorker,
  leasesStats,
  type TokenList,
  type TokenRecord,
  workerNameOfLease,
  workerOfLease,
} from "./leases-model";
import type { WorkerList, WorkerView } from "./workers-model";

/**
 * The leases views (ADR 0013 §1): every lease at `/leases`, from `GET /v1/leases`, and one lease
 * at `/leases/<id>/`, from `GET /v1/leases/{id}`. A holder is named from `GET /v1/tokens`, and a
 * lease's device and worker from `GET /v1/workers`.
 */
export function LeasesView() {
  const id = leaseIdFrom(usePath());
  return (
    <section className="view">{id === undefined ? <FleetLeases /> : <Lease id={id} />}</section>
  );
}

/** Every lease the daemon lists: on a gateway, the whole fleet's. */
function FleetLeases() {
  const leases = useLiveResource<LeaseList>("/v1/leases");
  const tokens = useTokens();
  const workers = useWorkers();
  const now = useNow();
  return (
    <>
      <PageHeader
        title="Leases"
        subtitle="Who holds which device, on which worker, and for how much longer."
      />
      <Loaded state={leases}>
        {(list) => (
          <>
            <StatCards stats={leasesStats(list.leases, now.server)} />
            <Panel
              title="All leases"
              description="Every lease the daemon holds. Select one to see its details."
            >
              <LeaseTable
                leases={list.leases}
                tokens={tokens}
                workers={workers}
                now={now.server}
                showWorker
              />
            </Panel>
          </>
        )}
      </Loaded>
    </>
  );
}

/** The leases on one worker, for that worker's page. */
export function WorkerLeases(props: {
  readonly worker: WorkerView;
  readonly workers: readonly WorkerView[];
  readonly now: number;
}) {
  const leases = useLiveResource<LeaseList>("/v1/leases");
  const tokens = useTokens();
  return (
    <Loaded state={leases}>
      {(list) => (
        <LeaseTable
          leases={leasesOnWorker(list.leases, props.worker.id, props.workers)}
          tokens={tokens}
          workers={props.workers}
          now={props.now}
          showWorker={false}
        />
      )}
    </Loaded>
  );
}

/**
 * The token records, or none while they have not arrived or were refused: a holder then shows
 * its id alone, and the leases still show.
 */
function useTokens(): readonly TokenRecord[] {
  return useLiveResource<TokenList>("/v1/tokens").data?.tokens ?? [];
}

function useWorkers(): readonly WorkerView[] {
  return useLiveResource<WorkerList>("/v1/workers").data?.workers ?? [];
}

/** A lease's holder: the token's label with the token id beside it, or the id alone. */
function HolderName({ holder }: { readonly holder: Holder }) {
  if (holder.label === undefined) return <span className="mono">{holder.id}</span>;
  return (
    <>
      {holder.label} <span className="muted mono">{holder.id}</span>
    </>
  );
}

/** Each lease as a row. On a phone each row stacks into a block of labelled lines. */
export function LeaseTable(props: {
  readonly leases: readonly LeaseRecord[];
  readonly tokens: readonly TokenRecord[];
  readonly workers: readonly WorkerView[];
  /** The daemon's time now, for every time on the page. */
  readonly now: number;
  /** Off on a worker's own page, where every lease is on that worker. */
  readonly showWorker: boolean;
}) {
  const { leases, now, showWorker, tokens, workers } = props;
  if (leases.length === 0) return <p className="muted">No leases.</p>;
  return (
    <table className="table table-wide">
      <thead>
        <tr>
          <th scope="col">Lease</th>
          <th scope="col">Holder</th>
          {showWorker ? <th scope="col">Worker</th> : null}
          <th scope="col">Device</th>
          <th scope="col">Mode</th>
          <th scope="col">Image tag</th>
          <th scope="col" className="num">
            Granted
          </th>
          <th scope="col" className="num">
            Expires in
          </th>
          <th scope="col" className="num">
            Last renewed
          </th>
        </tr>
      </thead>
      <tbody>
        {leases.map((lease) => {
          const device = deviceOfLease(lease, workers);
          return (
            <tr key={`${lease.workerId ?? ""} ${lease.id}`}>
              <td data-label="Lease">
                <Link to={leasePath(lease.id)} className="id" title={lease.id}>
                  {lease.id}
                </Link>
              </td>
              <td data-label="Holder">
                <span>
                  <HolderName holder={holderOf(lease.requesterId, tokens)} />
                </span>
              </td>
              {showWorker ? (
                <td data-label="Worker">
                  <LeaseWorker lease={lease} workers={workers} />
                </td>
              ) : null}
              <td data-label="Device">
                <span>
                  {device === undefined ? null : <>{device.spec.model} </>}
                  <span className="muted">
                    <Id>{lease.deviceId}</Id>
                  </span>
                </span>
              </td>
              <td data-label="Mode">{device?.mode ?? "—"}</td>
              <td data-label="Image tag" className="mono">
                {device?.spec.imageTag ?? "—"}
              </td>
              <td data-label="Granted" className="num">
                <Ago at={lease.grantedAt} now={now} />
              </td>
              <td data-label="Expires in" className="num">
                <Until at={lease.ttlDeadline} now={now} />
              </td>
              <td data-label="Last renewed" className="num">
                <Ago at={lease.lastRenewedAt} now={now} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The worker a lease is on, by its label, or by its id on one line when it has none. */
function LeaseWorker(props: {
  readonly lease: LeaseRecord;
  readonly workers: readonly WorkerView[];
}) {
  const name = workerNameOfLease(props.lease, props.workers);
  if (name === undefined) return "—";
  const labelled = workerOfLease(props.lease, props.workers)?.label !== undefined;
  return labelled ? name : <Id>{name}</Id>;
}

/** How long ago `at` was, with the moment itself for a tooltip and a machine. */
function Ago({ at, now }: { readonly at: number; readonly now: number }) {
  return <time dateTime={isoOf(at)}>{formatDuration(now - at)} ago</time>;
}

/** How long until `at`, counting down; `0 s` once it has passed. */
function Until({ at, now }: { readonly at: number; readonly now: number }) {
  return <time dateTime={isoOf(at)}>{formatDuration(at - now)}</time>;
}

function isoOf(at: number): string | undefined {
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

/** One lease: everything the list says about it, plus its request id and its device's udid. */
function Lease({ id }: { readonly id: string }) {
  const details = useLiveResource<{ readonly lease: LeaseDetails }>(
    `/v1/leases/${encodeURIComponent(id)}`,
  );
  const leases = useLiveResource<LeaseList>("/v1/leases");
  const tokens = useTokens();
  const workers = useWorkers();
  const now = useNow();
  const gone = isUnknownLease(details.error);
  return (
    <>
      {gone ? (
        <>
          <PageHeader title="Lease not found" actions={<AllLeases />} />
          <p className="muted">
            No lease has the id <code>{id}</code>. A lease that was released or expired is gone.
          </p>
        </>
      ) : (
        <>
          <PageHeader
            title={id}
            mono
            subtitle="One lease: who holds it, its device, and when it expires."
            actions={<AllLeases />}
          />
          <Loaded state={details}>
            {({ lease }) => (
              <Panel title="Details" description="As the daemon holds the lease now.">
                <LeaseFacts
                  lease={lease}
                  record={leases.data?.leases.find((candidate) => candidate.id === lease.id)}
                  tokens={tokens}
                  workers={workers}
                  now={now.server}
                />
              </Panel>
            )}
          </Loaded>
        </>
      )}
    </>
  );
}

function AllLeases() {
  return (
    <Link to="/leases" className="button button-secondary">
      All leases
    </Link>
  );
}

function isUnknownLease(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === "UNKNOWN_LEASE";
}

/** A lease's facts. `record` is its entry in `GET /v1/leases`: who holds it, when it was renewed. */
export function LeaseFacts(props: {
  readonly lease: LeaseDetails;
  readonly record: LeaseRecord | undefined;
  readonly tokens: readonly TokenRecord[];
  readonly workers: readonly WorkerView[];
  readonly now: number;
}) {
  const { lease, now, record, tokens, workers } = props;
  const worker = workerNameOfLease(
    { worker: lease.worker, workerId: lease.workerId ?? record?.workerId },
    workers,
  );
  return (
    <dl className="facts">
      <Fact label="Holder">
        {record === undefined ? "—" : <HolderName holder={holderOf(record.requesterId, tokens)} />}
      </Fact>
      <Fact label="Worker">{worker ?? "—"}</Fact>
      <Fact label="Device">{lease.device}</Fact>
      <Fact label="Device id" mono>
        {lease.deviceId}
      </Fact>
      <Fact label="UDID" mono>
        {lease.udid}
      </Fact>
      <Fact label="Mode">{lease.mode}</Fact>
      <Fact label="Image tag" mono>
        {lease.imageTag ?? "—"}
      </Fact>
      <Fact label="Granted" mono>
        <Ago at={Date.parse(lease.createdAt)} now={now} />
      </Fact>
      <Fact label="Expires in" mono>
        <Until at={Date.parse(lease.expiresAt)} now={now} />
      </Fact>
      <Fact label="Last renewed" mono>
        {record === undefined ? "—" : <Ago at={record.lastRenewedAt} now={now} />}
      </Fact>
      {lease.requestId === undefined ? null : (
        <Fact label="Request" mono>
          {lease.requestId}
        </Fact>
      )}
    </dl>
  );
}

function Fact(props: {
  readonly label: string;
  readonly mono?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd className={props.mono === true ? "mono" : undefined}>{props.children}</dd>
    </div>
  );
}
