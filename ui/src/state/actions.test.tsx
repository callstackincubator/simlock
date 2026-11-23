import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ApiClient, ApiPath, WriteOptions } from "../data/api";
import { workerActions } from "../model/actions";
import { type Actions, useActions } from "./actions";
import { type Live, LiveContext } from "./live";
import { ConsoleProvider } from "./services";

function probeActions(api: ApiClient, role: "admin" | "viewer"): Actions | undefined {
  let actions: Actions | undefined;
  const Probe = () => {
    actions = useActions();
    return null;
  };
  renderToStaticMarkup(
    <ConsoleProvider
      api={api}
      confirm={(_spec, work) => work()}
      fetch={() => Promise.reject(new Error("unused"))}
      notify={() => undefined}
      preferences={{} as never}
      session={{} as never}
    >
      <LiveContext.Provider
        value={{ identity: { canSignOut: true, name: "operator", role } } as unknown as Live}
      >
        <Probe />
      </LiveContext.Provider>
    </ConsoleProvider>,
  );
  return actions;
}

describe("running an item's action", () => {
  it("passes the update's 100-second bound to the write, and no bound for an action without one", async () => {
    const writes: { path: ApiPath; options: WriteOptions | undefined }[] = [];
    const api = {
      write: (_method: string, path: ApiPath, options?: WriteOptions) => {
        writes.push({ options, path });
        return Promise.resolve(undefined);
      },
    } as unknown as ApiClient;
    const actions = probeActions(api, "admin");
    const worker = {
      connection: "connected",
      drained: false,
      id: "w1",
      name: "mac-1",
      updateFacts: { latestVersion: "0.4.0", leased: 0, update: null, version: "0.3.0" },
    } as const;
    const offered = workerActions(worker, "gateway");
    const update = offered.find((action) => action.id === "update-worker");
    const drain = offered.find((action) => action.id === "drain");

    await actions?.run(update!);
    await actions?.run(drain!);

    expect(writes.map((write) => [write.path, write.options?.timeoutMs])).toEqual([
      ["/v1/workers/w1/update", 100_000],
      ["/v1/workers/w1/drain", undefined],
    ]);
  });

  it("hides entries and sends no write for a read-only viewer", async () => {
    const writes: ApiPath[] = [];
    const api = {
      write: (_method: string, path: ApiPath) => {
        writes.push(path);
        return Promise.resolve(undefined);
      },
    } as unknown as ApiClient;
    const actions = probeActions(api, "viewer");
    const offered = workerActions(
      { connection: "connected", drained: false, id: "w1", name: "mac-1" },
      "gateway",
    );

    expect(actions?.entries(offered)).toEqual([]);
    await actions?.run(offered[0]!);
    expect(writes).toEqual([]);
  });
});
