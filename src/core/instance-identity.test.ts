import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type Filesystem,
  type IdGenerator,
  MemoryFilesystem,
  NodeFilesystem,
} from "../ports/index.js";
import { InstanceIdentityError, loadInstanceId } from "./index.js";

const path = "/home/agent/.simlock/instance.json";

function sequence(prefix = "generated"): IdGenerator {
  let next = 1;
  return { generate: () => `${prefix}-${next++}` };
}

async function seed(contents: string): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp("/home/agent/.simlock");
  await filesystem.writeFileAtomic(path, contents);
  return filesystem;
}

async function load(filesystem: Filesystem): Promise<string> {
  return loadInstanceId({ filesystem, idGenerator: sequence(), path });
}

describe("loadInstanceId", () => {
  it("returns the identity already on disk", async () => {
    const filesystem = await seed(JSON.stringify({ instanceId: "written-long-ago" }));

    await expect(load(filesystem)).resolves.toBe("written-long-ago");
  });

  it("generates an identity on first start and persists it", async () => {
    const filesystem = new MemoryFilesystem();

    await expect(load(filesystem)).resolves.toBe("generated-1");
    await expect(filesystem.readFile(path).then(JSON.parse)).resolves.toEqual({
      instanceId: "generated-1",
    });
  });

  it("keeps returning the identity it generated on the first start", async () => {
    const filesystem = new MemoryFilesystem();
    const idGenerator = sequence();

    const first = await loadInstanceId({ filesystem, idGenerator, path });
    const second = await loadInstanceId({ filesystem, idGenerator, path });

    expect(second).toBe(first);
  });

  it("adopts the identity another daemon wrote first rather than overwriting it", async () => {
    // Two daemons starting for the first time at once: the loser has to end up with the
    // winner's id, and must not put its own on top of one the winner has already stamped
    // into its device roots.
    const filesystem = new LosingRaceFilesystem();

    await expect(load(filesystem)).resolves.toBe("won-the-race");
    await expect(filesystem.readFile(path).then(JSON.parse)).resolves.toEqual({
      instanceId: "won-the-race",
    });
  });

  it.each([
    ["is not valid JSON", "{ definitely not json"],
    ["carries no instanceId", JSON.stringify({ instance: "typo" })],
    ["carries an empty instanceId", JSON.stringify({ instanceId: "" })],
    ["carries a non-string instanceId", JSON.stringify({ instanceId: 7 })],
    ["is not an object at all", JSON.stringify("just-a-string")],
  ])("refuses to regenerate an identity whose file %s", async (_case, contents) => {
    const filesystem = await seed(contents);

    await expect(load(filesystem)).rejects.toBeInstanceOf(InstanceIdentityError);
    // The unusable file stays exactly as it was: overwriting it would strand every device
    // already sitting in a root marked with the id it used to hold.
    await expect(filesystem.readFile(path)).resolves.toBe(contents);
  });

  it("refuses an identity file it cannot read", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(path);

    await expect(load(filesystem)).rejects.toBeInstanceOf(InstanceIdentityError);
  });
});

describe("loadInstanceId on a real filesystem", () => {
  let home: string | undefined;

  afterEach(async () => {
    if (home !== undefined) {
      await rm(home, { force: true, recursive: true });
      home = undefined;
    }
  });

  it("hands every daemon racing to write the first identity the same one", async () => {
    // Against a real kernel this time, because the exclusive create is what makes the
    // guarantee: with a check followed by a write, one daemon's id lands on top of one the
    // other has already marked its roots with, and those roots read `wrong-instance` for
    // ever afterwards.
    const filesystem = new NodeFilesystem();
    home = await mkdtemp(join(tmpdir(), "simlock-instance-identity-"));
    const racedPath = join(home, "instance.json");
    const idGenerator = sequence("racer");

    const results = await Promise.allSettled(
      [0, 1, 2].map(async () => loadInstanceId({ filesystem, idGenerator, path: racedPath })),
    );

    const identities = results.map((result) =>
      result.status === "fulfilled" ? result.value : String(result.reason),
    );
    const onDisk = JSON.parse(await filesystem.readFile(racedPath)) as { instanceId: string };
    expect(identities).toEqual([onDisk.instanceId, onDisk.instanceId, onDisk.instanceId]);
    // Written once: the two that lost the race read the winner's file instead of writing.
    await expect(filesystem.readdir(home)).resolves.toEqual(["instance.json"]);
  });
});

/** Stands in for another daemon whose exclusive create landed first. */
class LosingRaceFilesystem extends MemoryFilesystem {
  async writeFileExclusive(target: string, _contents: string): Promise<void> {
    await super.writeFileAtomic(target, JSON.stringify({ instanceId: "won-the-race" }));
    const error: NodeJS.ErrnoException = new Error(`File already exists: ${target}`);
    error.code = "EEXIST";
    throw error;
  }
}
