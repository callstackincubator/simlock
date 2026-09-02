import { describe, expect, it } from "vitest";

import { type Filesystem, type IdGenerator, MemoryFilesystem } from "../ports/index.js";
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

  it("returns the identity that reached disk rather than the one it generated", async () => {
    // Two daemons starting for the first time at once: only one file survives, and the
    // loser has to end up with the winner's id or it will mark roots with an id nobody
    // else recognises.
    const filesystem = new LosingRaceFilesystem();

    await expect(load(filesystem)).resolves.toBe("won-the-race");
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

/** Stands in for another daemon whose write landed last. */
class LosingRaceFilesystem extends MemoryFilesystem {
  async writeFileAtomic(target: string, _contents: string): Promise<void> {
    await super.writeFileAtomic(target, JSON.stringify({ instanceId: "won-the-race" }));
  }
}
