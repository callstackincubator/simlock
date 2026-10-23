/**
 * why: a `device.exec` command runs as the daemon's user for whoever holds a lease, so it gets
 * only what the wrapped tools need to start; every other key of the daemon's environment (CI
 * tokens, cloud keys, launchd-injected values) is not passed on. This is no secrecy boundary: the
 * command runs as the daemon's user and can still read the daemon's own environment.
 */
const KEPT_KEYS: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  // why: xcrun reads it to pick the Xcode whose simctl and devicectl run.
  "DEVELOPER_DIR",
  // why: adb and the SDK tools find the SDK, its user files and the AVDs through these.
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "ANDROID_USER_HOME",
  "ANDROID_AVD_HOME",
  "ANDROID_PREFS_ROOT",
  "ANDROID_SDK_HOME",
  "JAVA_HOME",
]);

export function execBaseEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (KEPT_KEYS.has(key) || key.startsWith("LC_"))) kept[key] = value;
  }
  return kept;
}
