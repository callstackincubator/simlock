import { connectionStatus, healthStatus, Status } from "../status";
import { capacityByPlatform, deviceCounts, platformName, type WorkerView } from "./workers-model";

/** What the list says about a worker, and what its detail page starts with. */
export function WorkerFacts({ worker }: { readonly worker: WorkerView }) {
  const connection = connectionStatus(worker.connection);
  const counts = deviceCounts(worker);
  const capacity = capacityByPlatform(worker);
  return (
    <dl className="facts">
      <div>
        <dt>Connection</dt>
        <dd className="statuses">
          <Status tone={connection.tone}>{connection.word}</Status>
          {worker.drained ? (
            <>
              {" "}
              <Status tone="warn">drained</Status>
            </>
          ) : null}
        </dd>
      </div>
      <div>
        <dt>Health</dt>
        <dd>{worker.health === undefined ? "Not reported" : <Health health={worker.health} />}</dd>
      </div>
      <div>
        <dt>Protocol</dt>
        <dd>
          <Protocol worker={worker} />
        </dd>
      </div>
      <div>
        <dt>Version</dt>
        <dd className="mono">{worker.version ?? "Not reported"}</dd>
      </div>
      <div>
        <dt>Devices</dt>
        <dd>
          {counts === undefined
            ? "Not reported"
            : `${counts.running} running, ${counts.leased} leased`}
        </dd>
      </div>
      <div>
        <dt>Capacity</dt>
        <dd>
          {capacity.length === 0
            ? "Not reported"
            : capacity
                .map(
                  (entry) =>
                    `${platformName(entry.platform)} ${entry.running} of ${entry.limit} running`,
                )
                .join(", ")}
        </dd>
      </div>
    </dl>
  );
}

function Health({ health }: { readonly health: string }) {
  const status = healthStatus(health);
  return <Status tone={status.tone}>{status.word}</Status>;
}

/** Compatible or not; an incompatible worker names both protocol ranges, so an operator can
 * see which side to upgrade. */
function Protocol({ worker }: { readonly worker: WorkerView }) {
  if (worker.connection !== "incompatible" && worker.protocol === undefined) {
    return <Status tone="ok">compatible</Status>;
  }
  const { protocol } = worker;
  return (
    <>
      <Status tone="error">incompatible</Status>
      {protocol === undefined ? null : (
        <span className="mono">
          {" "}
          gateway {range(protocol.gateway)}, worker {range(protocol.worker)}
        </span>
      )}
    </>
  );
}

function range({ max, min }: { readonly min: number; readonly max: number }): string {
  return `${min}–${max}`;
}
