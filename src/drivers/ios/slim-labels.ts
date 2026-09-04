import { createHash } from "node:crypto";

// Data source: simslim (https://github.com/mobai-app/simslim), MIT licensed.
// Category names, descriptions, and launchd label lists below are copied
// verbatim from `Categories` in profiles.go at commit
// 65bda5bd746a32abff14fa1160e4d802e2b057c4 (2026-08-03), the source simslim
// uses to disable background daemons inside a booted simulator via
// `xcrun simctl spawn <udid> launchctl disable system/<label>` before a
// reboot (see docs/agent-rules for how simlock's own driver invokes this).
//
// Apple renames, adds, and removes these daemons between iOS runtime
// versions, so this list is versioned *data*, not code: it is expected to
// need periodic re-syncing against upstream simslim as new runtimes ship,
// and is deliberately kept out of any logic module so that resyncing it
// never requires touching driver behavior.

/** A named group of launchd daemon labels a slim boot may disable together. */
export interface SlimCategory {
  readonly name: string;
  readonly description: string;
  readonly labels: readonly string[];
}

export const SLIM_CATEGORIES: readonly SlimCategory[] = [
  {
    name: "widgets",
    description: "Home and lock screen posters, widgets, and Live Activities.",
    labels: ["com.apple.PosterBoard", "com.apple.chronod", "com.apple.liveactivitiesd"],
  },
  {
    name: "siri",
    description: "Siri, Apple Intelligence, speech, and on-device ML model services.",
    labels: [
      "com.apple.assistantd",
      "com.apple.assistant_cdmd",
      "com.apple.assistant_service",
      "com.apple.siriactionsd",
      "com.apple.siriinferenced",
      "com.apple.siriknowledged",
      "com.apple.sirittsd",
      "com.apple.siri.context.service",
      "com.apple.siri.acousticsignature",
      "com.apple.corespeechd",
      "com.apple.voiced",
      "com.apple.voicebankingd",
      "com.apple.speechmodeltrainingd",
      "com.apple.intelligenceplatformd",
      "com.apple.intelligencecontextd",
      "com.apple.intelligenceflowd",
      "com.apple.intelligencetasksd",
      "com.apple.generativeexperiencesd",
      "com.apple.knowledgeconstructiond",
      "com.apple.naturallanguaged",
      "com.apple.textunderstandingd",
      "com.apple.modelcatalogd",
      "com.apple.modelmanagerd",
      "com.apple.mlhostd",
      "com.apple.mlruntimed",
      "com.apple.suggestd",
      "com.apple.parsecd",
      "com.apple.parsec-fbf",
      "com.apple.proactiveeventtrackerd",
    ],
  },
  {
    name: "search",
    description: "On-device Spotlight and in-Settings search services.",
    labels: [
      "com.apple.searchd",
      "com.apple.searchtoold",
      "com.apple.spotlightknowledged",
      "com.apple.spotlightknowledged.updater",
      "com.apple.corespotlightservice",
    ],
  },
  {
    name: "icloud",
    description: "iCloud sync, Apple Account, keychain, and backup services.",
    labels: [
      "com.apple.appleaccountd",
      "com.apple.appleaccounttransparencyd",
      "com.apple.appleidsetupd",
      "com.apple.akd",
      "com.apple.amsaccountsd",
      "com.apple.amsengagementd",
      "com.apple.amsondevicestoraged",
      "com.apple.cloudd",
      "com.apple.cloudphotod",
      "com.apple.ckdiscretionaryd",
      "com.apple.cloudsettingssyncagent",
      "com.apple.bird",
      "com.apple.syncdefaultsd",
      "com.apple.cdpd",
      "com.apple.sosd",
      "com.apple.SecureBackupDaemon",
      "com.apple.TrustedPeersHelper",
      "com.apple.protectedcloudstorage.protectedcloudkeysyncing",
      "com.apple.icloudmailagent",
      "com.apple.icloudsubscriptionoptimizerd",
      "com.apple.communicationtrustd",
    ],
  },
  {
    name: "store",
    description: "App Store, push notification, StoreKit, and media services.",
    labels: [
      "com.apple.appstored",
      "com.apple.appstorecomponentsd",
      "com.apple.apsd",
      "com.apple.itunescloudd",
      "com.apple.itunesstored",
      "com.apple.storekitd",
      "com.apple.amsaccountsd",
      "com.apple.amsengagementd",
      "com.apple.amsondevicestoraged",
      "com.apple.passd",
      "com.apple.financed",
      "com.apple.videosubscriptionsd",
      "com.apple.assetsubscriptiond",
      "com.apple.musicd",
    ],
  },
  {
    name: "pim",
    description: "Mail, Calendar, Contacts, Reminders, and related sync services.",
    labels: [
      "com.apple.email.maild",
      "com.apple.exchangesyncd",
      "com.apple.dataaccess.dataaccessd",
      "com.apple.calaccessd",
      "com.apple.remindd",
      "com.apple.contactsd",
      "com.apple.contacts.postersyncd",
      "com.apple.peopled",
    ],
  },
  {
    name: "web",
    description: "Safari sync, web push, privacy, and universal-link services.",
    labels: [
      "com.apple.SafariBookmarksSyncAgent",
      "com.apple.Safari.History",
      "com.apple.Safari.passwordbreachd",
      "com.apple.Safari.SafeBrowsing.Service",
      "com.apple.safarifetcherd",
      "com.apple.WebBookmarks.webbookmarksd",
      "com.apple.webkit.adattributiond",
      "com.apple.webkit.webpushd",
      "com.apple.webprivacyd",
      "com.apple.swcd",
    ],
  },
  {
    name: "family",
    description: "Family Sharing, Screen Time, and usage tracking.",
    labels: [
      "com.apple.familycircled",
      "com.apple.FamilyControlsAgent",
      "com.apple.familynotification",
      "com.apple.askpermissiond",
      "com.apple.asktod",
      "com.apple.ScreenTimeAgent",
      "com.apple.ScreenTimeSettingsAgent",
      "com.apple.UsageTrackingAgent",
    ],
  },
  {
    name: "health",
    description: "HealthKit, HomeKit, and Fitness services.",
    labels: [
      "com.apple.healthd",
      "com.apple.healthappd",
      "com.apple.healthcontentd",
      "com.apple.healtheventsd",
      "com.apple.healthrecordsd",
      "com.apple.finhealthd",
      "com.apple.homed",
      "com.apple.homeeventsd",
      "com.apple.fitcore",
      "com.apple.fitcore.session",
      "com.apple.fitnesscoachingd",
      "com.apple.fitnessintelligenced",
      "com.apple.activityawardsd",
      "com.apple.activitysharingd",
    ],
  },
  {
    name: "photos",
    description: "Photos library, photo analysis, and media analysis services.",
    labels: [
      "com.apple.photoanalysisd",
      "com.apple.photosface",
      "com.apple.mediaanalysisd",
      "com.apple.mediaanalysisd.service",
      "com.apple.mediastream.mstreamd",
      "com.apple.medialibraryd",
      "com.apple.assetsd",
      "com.apple.assetsd.nebulad",
    ],
  },
  {
    name: "apps",
    description: "News, Weather, Maps, Tips, and game services.",
    labels: [
      "com.apple.newsd",
      "com.apple.weatherd",
      "com.apple.Maps.mapssyncd",
      "com.apple.Maps.mapspushd",
      "com.apple.Maps.geocorrectiond",
      "com.apple.maps.destinationd",
      "com.apple.MapKit.SnapshotService",
      "com.apple.jetpackassetd",
      "com.apple.tipsd",
      "com.apple.gamed",
      "com.apple.gamesaved",
      "com.apple.GameController.gamecontrollerd",
    ],
  },
  {
    name: "messaging",
    description: "iMessage, FaceTime, call, and identity services.",
    labels: [
      "com.apple.identityservicesd",
      "com.apple.ids_simd",
      "com.apple.imautomatichistorydeletionagent",
      "com.apple.imcore.imtransferagent",
      "com.apple.imdpersistence.IMDPersistenceAgent",
      "com.apple.facetimemessagestored",
      "com.apple.telephonyutilities.callservicesd",
    ],
  },
  {
    name: "connectivity",
    description: "AirDrop, Continuity, CarPlay, Watch, and Find My services.",
    labels: [
      "com.apple.rapportd",
      "com.apple.companiond",
      "com.apple.carkitd",
      "com.apple.wcd",
      "com.apple.tvremoted",
      "com.apple.avatarsd",
      "com.apple.stickersd",
      "com.apple.sociallayerd",
      "com.apple.announced",
      "com.apple.navd",
      "com.apple.findmy.findmylocated",
    ],
  },
  {
    name: "telemetry",
    description: "DeviceCheck, ad privacy, analytics, diagnostics, and feedback services.",
    labels: [
      "com.apple.ap.adprivacyd",
      "com.apple.ap.promotedcontentd",
      "com.apple.diagnosticextensionsd",
      "com.apple.feedbackd",
      "com.apple.rtcreportingd",
      "com.apple.securityuploadd",
      "com.apple.geoanalyticsd",
      "com.apple.triald",
      "com.apple.followupd",
      "com.apple.purplebuddy.budd",
      "com.apple.devicecheckd",
    ],
  },
  {
    name: "other",
    description: "Wallet, business services, assets, and miscellaneous background daemons.",
    labels: [
      "com.apple.financed",
      "com.apple.passd",
      "com.apple.merchantd",
      "com.apple.coreidvd",
      "com.apple.businessservicesd",
      "com.apple.deviceaccessd",
      "com.apple.replicatord",
      "com.apple.linkd",
      "com.apple.ind",
      "com.apple.storagedatad",
      "com.apple.StatusKitAgent",
      "com.apple.countryd",
      "com.apple.mobileassetd",
      "com.apple.managedconfiguration.passcodenagd",
    ],
  },
];

export const SLIM_CATEGORY_NAMES: readonly string[] = SLIM_CATEGORIES.map((c) => c.name);

/**
 * Resolves a set of requested category names to their {@link SlimCategory}
 * definitions. `undefined` (no filter given) resolves to every category.
 * Names that don't match any known category are reported separately as
 * `unknown` rather than throwing, so a caller can warn and proceed with the
 * categories it did recognize instead of failing the whole request.
 */
export function resolveSlimCategories(requested: readonly string[] | undefined): {
  readonly categories: readonly SlimCategory[];
  readonly unknown: readonly string[];
} {
  if (requested === undefined) {
    return { categories: SLIM_CATEGORIES, unknown: [] };
  }
  const byName = new Map(SLIM_CATEGORIES.map((c) => [c.name, c] as const));
  const categories: SlimCategory[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const name of requested) {
    const category = byName.get(name);
    if (category === undefined) {
      unknown.push(name);
      continue;
    }
    if (!seen.has(name)) {
      seen.add(name);
      categories.push(category);
    }
  }
  return { categories, unknown };
}

/** Deduplicated, deterministically sorted labels across the given categories. */
export function labelsFor(categories: readonly SlimCategory[]): readonly string[] {
  const labels = new Set<string>();
  for (const category of categories) {
    for (const label of category.labels) {
      labels.add(label);
    }
  }
  return Array.from(labels).sort();
}

const SIGNATURE_SCHEMA_VERSION = "v1";

/**
 * A short, stable signature over the resolved category names and their
 * labels. Used as an idempotence marker: it changes whenever either the
 * requested category selection or the shipped label data changes, so a
 * stored marker from a stale config or an older simlock version is detected
 * as stale rather than silently trusted.
 */
export function slimSignature(categories: readonly SlimCategory[]): string {
  // Pure computation over in-memory data (no filesystem/process/network
  // access), so this does not need a port per architecture rule 9.
  const sorted = [...categories].sort((a, b) => a.name.localeCompare(b.name));
  const payload = sorted.map((c) => `${c.name}:${[...c.labels].sort().join(",")}`).join("|");
  const hash = createHash("sha256").update(payload).digest("hex").slice(0, 16);
  return `${SIGNATURE_SCHEMA_VERSION}:${hash}`;
}
