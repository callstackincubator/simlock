import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ApiClient, ApiPath, WriteOptions } from "../data/api";
import { workerActions } from "../model/actions";
import { type Actions, useActions } from "./actions";
import { ConsoleProvider } from "./services";

describe("running an item's action", () => {
  it("passes the update's 100-second bound to the write, and no bound for an action without one", async () => {
    const writes: { path: ApiPath; options: WriteOptions | undefined }[] = [];
    const api = {
      write: (_method: string, path: ApiPath, options?: WriteOptions) => {
        writes.push({ options, path });
        return Promise.resolve(undefined);
      },
    } as unknown as ApiClient;
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
        <Probe />
      </ConsoleProvider>,
    );
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
});
