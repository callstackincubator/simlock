# Device preparation — 2026-10-16

User confirmed the HEVC capability correction resolved video corruption.
New symptom: mediaStreamSupportInfo fails with remoteService XPC unavailable and
HID capabilities are missing until DeviceHub runs. This occurs before streaming.

Installed DeviceKit imports RemoteDevice.acquireDeviceUsageAssertion(withReason:
requirements:), the corresponding requirements/state types, and releaseAssertion.
Disassembly of DeviceInteractionModel around 0x4a8a10 builds the state set from
getters developerModeEnabledIfRequired, coreDeviceServicesLoaded,
extendedDeviceInfoLoaded and remoteServiceDiscoveryTrustedConnectivityAvailable,
then conditionally inserts secureNetworkingAvailable at 0x4a8a5c.
The demo targets physical devices and requests all five.

The assertion is awaited before media support, negotiation options and tunnel IP
are read. HID setup also waits. The local reference holds the assertion through
remote stream stop; defer releases it on success, failure and cancellation. A
successful acquisition followed by cancellation is also released. Unexpected
assertion invalidation cancels the stream. Error logs identify the failing stage.
No global disconnect or release of other apps' assertions is performed.

No live test performed, per user request. Build and launch only. User should test
with DeviceHub fully closed and a fresh device connection. Backup files are in
work/pre-device-preparation. No entitlement or system protection changes.
