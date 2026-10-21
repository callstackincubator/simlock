import type { Clock, Logger } from "../../ports/index.js";
import type { Platform, VirtualSpec } from "../domain.js";
import type { DriverCatalog, PlatformCatalog } from "../driver-catalog.js";
import { stableError } from "../stable-error.js";
import type { LearnedKind } from "./learned.js";

/** why: the longest the pool waits for a catalog read; `avdmanager` has no timeout of its own. */
const CATALOG_READ_LIMIT_MS = 30_000;

interface CatalogCheckOptions {
  readonly catalog: Pick<DriverCatalog, "listCatalog">;
  readonly clock: Clock;
  readonly hasDriver: (platform: Platform) => boolean;
  readonly logger: Logger;
  /** why: a read lists a platform that had no answer, so the kinds waiting on it can be planned now, not at the next tick. A failed or timed out read does not call it: its retry would loop. */
  readonly onAnswer: () => void;
}

/**
 * why: reads each platform's catalog beside a pass, never blocking it, and says which learned kinds
 * the last answers no longer list. A read that throws or runs past the limit leaves its platform
 * with no answer, so none of its kinds is judged on it: they are kept, and planned for nothing
 * (`unanswered`) until a read lists the platform, which asks for a pass at once (ADR 0038 §4, §5).
 */
export class CatalogCheck {
  readonly #answers = new Map<Platform, PlatformCatalog>();
  readonly #pending = new Set<Platform>();

  constructor(private readonly options: CatalogCheckOptions) {}

  /** why: starts a read for each of `platforms` that has none pending. */
  start(platforms: ReadonlySet<Platform>): void {
    for (const platform of platforms) {
      if (this.#pending.has(platform) || !this.options.hasDriver(platform)) continue;
      this.#read(platform);
    }
  }

  /** why: the kinds whose platform has no driver, or that the latest answer for it does not list. */
  gone(kinds: readonly LearnedKind[]): LearnedKind[] {
    return kinds.filter((kind) => {
      const { platform } = kind.spec;
      if (!this.options.hasDriver(platform)) return true;
      const answer = this.#answers.get(platform);
      return answer !== undefined && !lists(answer, kind.spec);
    });
  }

  /** why: the kinds whose platform has a driver and no answer yet: a read pending, failed or timed out. */
  unanswered(kinds: readonly LearnedKind[]): LearnedKind[] {
    return kinds.filter(
      (kind) =>
        this.options.hasDriver(kind.spec.platform) && !this.#answers.has(kind.spec.platform),
    );
  }

  #read(platform: Platform): void {
    const { catalog, clock, logger } = this.options;
    this.#pending.add(platform);
    let abandoned = false;
    const timer = clock.setTimer(CATALOG_READ_LIMIT_MS, () => {
      abandoned = true;
      this.#pending.delete(platform);
      this.#answers.delete(platform);
      logger.warn("a warm pool catalog read took too long", { platform });
    });
    const finish = (): boolean => {
      if (abandoned) return false;
      clock.cancel(timer);
      this.#pending.delete(platform);
      return true;
    };
    catalog.listCatalog(platform).then(
      (entries) => {
        if (!finish()) return;
        const entry = entries.find((candidate) => candidate.platform === platform);
        if (entry === undefined) this.#answers.delete(platform);
        else {
          const first = !this.#answers.has(platform);
          this.#answers.set(platform, entry);
          if (first) this.options.onAnswer();
        }
      },
      (error: unknown) => {
        if (!finish()) return;
        this.#answers.delete(platform);
        logger.warn("a warm pool catalog read failed", { platform, error: stableError(error) });
      },
    );
  }
}

function lists(catalog: PlatformCatalog, spec: VirtualSpec): boolean {
  if (!catalog.models.includes(spec.model)) return false;
  if (!(catalog.modelRuntimes[spec.model] ?? []).includes(spec.osVersion)) return false;
  if (spec.imageTag === undefined) return true;
  return (catalog.images ?? []).some(
    (image) => image.runtime === spec.osVersion && image.tag === spec.imageTag,
  );
}
