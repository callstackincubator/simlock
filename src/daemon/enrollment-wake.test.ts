import { describe, expect, it, vi } from "vitest";

import type { PhysicalDevice } from "../core/index.js";
import { wakingQueueAfter } from "./enrollment-wake.js";

const device = { id: "dev_1" } as PhysicalDevice;

describe("wakingQueueAfter", () => {
  it("wakes once after an add commits, answers what the add answered, and wakes nothing when it is refused", async () => {
    const wake = vi.fn();
    const add = vi.fn().mockResolvedValueOnce({ device, reenrolled: false });
    const enrollment = wakingQueueAfter({ add, remove: vi.fn() }, wake);

    const added = await enrollment.add("ios", "UDID");

    expect(added).toEqual({ device, reenrolled: false });
    expect(add).toHaveBeenCalledWith("ios", "UDID");
    expect(wake).toHaveBeenCalledTimes(1);

    add.mockRejectedValueOnce(new Error("busy"));
    await expect(enrollment.add("ios", "UDID")).rejects.toThrow("busy");
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("wakes once after a remove commits, answers what the remove answered, and wakes nothing when it is refused", async () => {
    const wake = vi.fn();
    const remove = vi.fn().mockResolvedValueOnce(device);
    const enrollment = wakingQueueAfter({ add: vi.fn(), remove }, wake);

    const removed = await enrollment.remove("UDID");

    expect(removed).toBe(device);
    expect(remove).toHaveBeenCalledWith("UDID");
    expect(wake).toHaveBeenCalledTimes(1);

    remove.mockRejectedValueOnce(new Error("leased"));
    await expect(enrollment.remove("UDID")).rejects.toThrow("leased");
    expect(wake).toHaveBeenCalledTimes(1);
  });
});
