import type { DispatcherOptions } from "./dispatcher.js";

type Enrollment = NonNullable<DispatcherOptions["enrollment"]>;

/**
 * At the composition root because the core cannot reach leasing: the wake is leasing's port, which
 * only the daemon holds.
 */
export function wakingQueueAfter(enrollment: Enrollment, wake: () => void): Enrollment {
  return {
    add: async (platform, id) => {
      const added = await enrollment.add(platform, id);
      wake();
      return added;
    },
    remove: async (id) => {
      const removed = await enrollment.remove(id);
      wake();
      return removed;
    },
  };
}
