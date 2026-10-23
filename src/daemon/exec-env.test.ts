import { describe, expect, it } from "vitest";

import { execBaseEnvironment } from "./exec-env.js";

// why: pure logic with many cases (testing rule 6); the startDaemon test in `main.test.ts` proves a `device.exec` child gets this list.
describe("execBaseEnvironment", () => {
  it("keeps only the allowlisted keys and every LC_ key, and drops every other key of the daemon's environment", () => {
    const kept = {
      ANDROID_AVD_HOME: "/Users/me/.android/avd",
      ANDROID_HOME: "/sdk",
      ANDROID_PREFS_ROOT: "/Users/me",
      ANDROID_SDK_HOME: "/Users/me",
      ANDROID_SDK_ROOT: "/sdk",
      ANDROID_USER_HOME: "/Users/me/.android",
      DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
      HOME: "/Users/me",
      JAVA_HOME: "/jdk",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
      LOGNAME: "me",
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/zsh",
      TERM: "xterm-256color",
      TMPDIR: "/var/folders/xy/T/",
      USER: "me",
    };
    const dropped = {
      ANDROID_SERIAL: "someone-elses-phone",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GITHUB_TOKEN: "ghp_secret",
      LCX: "not-a-locale",
      NPM_TOKEN: "npm-secret",
      SIMCTL_CHILD_SECRET: "reaches-the-simulator",
      SIMLOCK_HOME: "/Users/me/.simlock",
      XLC_CTYPE: "not-a-locale",
    };

    expect(execBaseEnvironment({ ...kept, ...dropped, UNSET: undefined })).toEqual(kept);
  });
});
