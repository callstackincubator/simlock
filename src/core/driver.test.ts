import { describe, expect, it } from "vitest";

import { MemoryFilesystem } from "../ports/index.js";
import { assertDiskSpace, DiskSpaceGuard, InsufficientDiskSpaceError } from "./driver.js";

const gibibyte = 1024 ** 3;

describe("assertDiskSpace", () => {
  it("resolves when free space covers the requirement", async () => {
    const filesystem = new MemoryFilesystem(10 * gibibyte);

    await expect(
      assertDiskSpace(filesystem, "ios", 6 * gibibyte, "/volume"),
    ).resolves.toBeUndefined();
  });

  it("throws InsufficientDiskSpaceError naming required and available bytes when it doesn't", async () => {
    const filesystem = new MemoryFilesystem(4 * gibibyte);

    const error = await assertDiskSpace(filesystem, "android", 6 * gibibyte, "/volume").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(InsufficientDiskSpaceError);
    expect(error).toMatchObject({
      availableBytes: 4 * gibibyte,
      platform: "android",
      requiredBytes: 6 * gibibyte,
    });
  });
});

describe("DiskSpaceGuard", () => {
  it("lets a single reservation through when it fits free space", async () => {
    const filesystem = new MemoryFilesystem(10 * gibibyte);
    const guard = new DiskSpaceGuard();

    await expect(guard.reserve(filesystem, "ios", 6 * gibibyte, "/volume")).resolves.toBeInstanceOf(
      Function,
    );
  });

  it("rejects a reservation that alone exceeds free space, with InsufficientDiskSpaceError", async () => {
    const filesystem = new MemoryFilesystem(4 * gibibyte);
    const guard = new DiskSpaceGuard();

    await expect(guard.reserve(filesystem, "ios", 6 * gibibyte, "/volume")).rejects.toBeInstanceOf(
      InsufficientDiskSpaceError,
    );
  });

  it("rejects a second concurrent reservation that would overfill the volume alongside the first", async () => {
    const filesystem = new MemoryFilesystem(10 * gibibyte);
    const guard = new DiskSpaceGuard();

    // First reservation fits (6 of 10 GiB); still outstanding when the second is attempted.
    const releaseFirst = await guard.reserve(filesystem, "ios", 6 * gibibyte, "/volume");

    // 10 GiB free minus the 6 GiB already reserved leaves 4 GiB -- not enough for another 6 GiB,
    // even though a bare disk-free reading alone would say yes.
    await expect(
      guard.reserve(filesystem, "android", 6 * gibibyte, "/volume"),
    ).rejects.toBeInstanceOf(InsufficientDiskSpaceError);

    releaseFirst();
  });

  it("frees the reservation on release, letting a subsequent reservation succeed", async () => {
    const filesystem = new MemoryFilesystem(10 * gibibyte);
    const guard = new DiskSpaceGuard();

    const releaseFirst = await guard.reserve(filesystem, "ios", 6 * gibibyte, "/volume");
    releaseFirst();

    await expect(
      guard.reserve(filesystem, "android", 6 * gibibyte, "/volume"),
    ).resolves.toBeInstanceOf(Function);
  });

  it("tracks reservations independently per path", async () => {
    const filesystem = new MemoryFilesystem(10 * gibibyte);
    const guard = new DiskSpaceGuard();

    // Both reservations are 6 of the same 10 GiB free reading, but against different paths --
    // neither should see the other's outstanding bytes.
    await expect(
      guard.reserve(filesystem, "ios", 6 * gibibyte, "/volume-a"),
    ).resolves.toBeInstanceOf(Function);
    await expect(
      guard.reserve(filesystem, "android", 6 * gibibyte, "/volume-b"),
    ).resolves.toBeInstanceOf(Function);
  });

  it("is idempotent: releasing twice does not double-free the reservation", async () => {
    const filesystem = new MemoryFilesystem(10 * gibibyte);
    const guard = new DiskSpaceGuard();

    const release = await guard.reserve(filesystem, "ios", 6 * gibibyte, "/volume");
    release();
    release();

    // A double release must not credit the 6 GiB back twice, which would let two more 6 GiB
    // reservations both succeed against only 10 GiB of real free space.
    const releaseSecond = await guard.reserve(filesystem, "ios", 6 * gibibyte, "/volume");
    await expect(
      guard.reserve(filesystem, "android", 6 * gibibyte, "/volume"),
    ).rejects.toBeInstanceOf(InsufficientDiskSpaceError);
    releaseSecond();
  });
});
