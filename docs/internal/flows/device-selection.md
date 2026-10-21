# Device selection

Modules: contract, daemon, [leasing](../../../src/leasing/AGENTS.md), [core](../../../src/core/AGENTS.md),
[drivers](../../../src/drivers/AGENTS.md) ([Android](../../../src/drivers/android/AGENTS.md),
[iOS](../../../src/drivers/ios/AGENTS.md)).

How one lease request becomes one concrete device, virtual or physical.

## Sources

| Source | Where | Read when |
|---|---|---|
| Request: `model` or `class`, `osVersion` (exact or range), `mode`, `imageTag`, `physical`, `allowDownload`, `noWait` | `contract/operations.ts` → `DeviceRequest` | Per request |
| Download permission | `downloads.policy` (`on-request`), `daemon/dispatcher.ts` | Per request, before leasing |
| Default mode | `ios.defaultMode` (`full`); Android always `full` | Per request with no `mode` |
| Operator preference lists | `ios.defaultModels`, `android.defaultModels` | Merged once at start |
| Built-in preference lists | `Driver.defaultModels` of each driver | Merged once at start, after the operator's |
| Catalog | `DriverCatalog.listCatalog` → `Driver.listCatalog` | Per class or range request; no cache |
| Android profile library (16) | `drivers/android/profiles/` | Static |
| Android SDK profiles | `avdmanager list device` | Each catalog; each resolve of a model the library lacks; each library provision (seed) |
| Android devices.xml | `$ANDROID_USER_HOME/devices.xml`, else `.android/devices.xml` | Each catalog; a resolve no earlier source answered |
| Android system images | `<sdk>/system-images/android-*/<tag>/<abi>` + `source.properties` | Each resolve, catalog, provision |
| Android fit rule | `drivers/android/image-fit.ts` `fits` | With every image read |
| iOS device types and runtimes | `simctl list -j devicetypes runtimes` | Each resolve, catalog |
| Existing devices | registry snapshot | Each plan |
| Enrolled physical devices | registry snapshot; presence from `Driver.listPresentPhysical` | Each physical plan; presence before each grant |
| Warm targets | `warmPool.targets` (`core/warm-pool/config.ts`), and the kinds the pool learned from leases (`core/warm-pool/learned.ts`, `state.db`) | Every warm-pool pass, downloads off |

Never read: the sdkmanager catalog. A preference list is merged in `daemon/main.ts`
`modelPreferenceWiring`; nothing else builds it.

## Virtual: request → spec

In `LeaseAcquisitionCoordinator` (`leasing/lease-acquisition-coordinator.ts`), no lock held:

1. `physical: true` → skip to the physical branch.
2. Mode = request's, else the platform default.
3. Shape of the request:
   - exact model, no range → used as is; no catalog read.
   - no model, no range → class (none named = `phone`).
   - range → with a model, the model must be listed in the catalog; without, class.
4. Class → `classCandidates` (`core/catalog-match.ts`): each preference name the catalog lists
   (names and aliases, ignoring case) and classes as that class, in list order. First one with
   a paired runtime the request accepts wins. None listed → `UnknownModelError`; none paired → `RuntimeMissingError`.
5. Range → newest paired runtime in range, passed on as an exact version. A range never installs.
6. Image tag → only runtimes whose catalog `images` carry the tag count.
7. `driver.resolveSpec(exact)`. `RuntimeMissingError` with `downloadable` and `component`, and
   `allowDownload` → `ComponentInstaller` installs, then resolve once more.
8. `checkedSpec`: tag must equal the request's; a non-slim request gets `fullSpec`.
9. Requirement: class or model target, OS (`range`, `exact`, or `installed` for a class with no
   OS), image tag. An exact model gets `exactRequirement(spec)`.

Warm targets go through the same steps (`resolve`) with `allowDownload: false`; a target names no class. A learned kind is already a resolved spec and is kept ready like a target.

## Android `resolveSpec`

1. `DeviceProfileRegistry.resolve(model)`: library → SDK → devices.xml; first name match,
   ignoring case, wins. No match → `UnknownModelError`.
2. Scan installed images.
3. With `imageTag`: images of that tag (at the requested level); none → `RuntimeMissingError`,
   never downloadable. Level = requested, else newest that fits.
4. Without: fitting API levels; level = requested, else newest. No fit →
   `RuntimeMissingError`; downloadable only for an exact level with no image at all and a
   `google_apis` image that would fit.
5. The profile is cached for `provision`. `mode` is ignored: the spec is full.

## iOS `resolveSpec`

1. `imageTag` → `UnsupportedRequestOptionError`.
2. Device type by name, ignoring case. No match → `UnknownModelError`.
3. No OS → newest installed runtime that lists the type and sits inside its min/max range.
4. Exact OS → out of range refused; installed and paired → spec; installed, unpaired refused; not installed → downloadable
   (`component` = the version; below iOS 16 not downloadable).
5. Slim spec only for a slim request on iOS 18.5+. Device type and runtime cached for `provision`.

## Spec → device

`AcquisitionPlanner.plan` (`leasing/acquisition-planner.ts`), under the lock. A device serves
when `mayBeGranted`, same pool mode, and `fits(requirement, spec, classOf)` (`core/domain.ts`):
same platform, same image tag, model equal or `classOf(model)` equal to the class, OS satisfied.
`classOf` reads the catalog entry read during resolution; a device record stores no class.

1. A `ready`, unclaimed device that serves → grant.
2. Unless `noWait`: one the warm pool is booting or creating under an ownerless claim (for a target or learned kind, a released device or a request queued behind) → wait.
3. A `shutdown` device that serves → boot it.
4. Else provision the spec, evict an idle device, wait, or `NO_CAPACITY`.

Existing devices are never re-checked against the Android fit rule: an older device serves a
class or range request whenever its OS satisfies it.

## Provision: image and profile

Android `provision`:
1. Profile from the `resolveSpec` cache, else resolved again.
2. Image: installed, fitting, at the spec's level. Order host-ABI `google_apis` → host ABI →
   `google_apis` → any. With a tag: that tag only, host ABI first.
3. `avdmanager create avd -d <seed>`: an SDK profile's own id, else the first
   `avdmanager list device` entry. Then devices.xml `hw.*` keys, or the library profile's
   keys and `boot.prop`, are written over it.

iOS `provision`: `simctl create` with the cached device type and runtime.

## Physical branch

1. The coordinator: no enrolled, non-deleted device fits (`fitsPhysical`: platform, model
   ignoring case or class, OS exact or range) → `unresolvable-spec`.
2. `planPhysical`: first `ready`, present, unclaimed fitting device no older physical waiter fits.
3. Presence is read outside the lock and checked again inside it before the grant.

Enrolled facts come from `inspectPhysical` at `simlock device add`:
Android model `ro.product.model`, OS = API level, class `phone`;
iOS model `marketingName` (else `productType`), OS `osVersionNumber`, iPad `tablet` else `phone`.
