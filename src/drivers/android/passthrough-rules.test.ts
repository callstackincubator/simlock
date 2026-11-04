import { describe, expect, it } from "vitest";

import { PassthroughRefusedError, type PassthroughContext } from "../../core/index.js";
import { FakeClock, ScriptedProcessRunner } from "../../ports/index.js";
import { AdbTools } from "./adb-tools.js";
import { PassthroughRules } from "./passthrough-rules.js";

const adbServerPort = 5038;
const sdkAdb = "/android-sdk/platform-tools/adb";

function rulesFor(): PassthroughRules {
  const processRunner = new ScriptedProcessRunner([]);
  return new PassthroughRules({
    adb: sdkAdb,
    adbServerPort,
    adbTools: new AdbTools({
      adb: sdkAdb,
      adbServerPort,
      baseEnv: {},
      clock: new FakeClock(),
      deviceRoot: "/devices/android",
      emulator: "/android-sdk/emulator/emulator",
      processRunner,
    }),
    physical: {
      passthrough: () => Promise.reject(new Error("a phone's passthrough is not under test")),
      runAdb: () => Promise.reject(new Error("a phone's adb is not under test")),
    },
    platform: "android",
    processRunner,
  });
}

/** why: every case below asks for the Android Debug Bridge version 1.0.41
Version 37.0.0-14910828
Installed as /Users/szymon.chmal/Library/Android/sdk/platform-tools/adb
Running on Darwin 25.6.0 (arm64)

global options:
 -a                       listen on all network interfaces, not just localhost
 -d                       use USB device (error if multiple devices connected)
 -e                       use TCP/IP device (error if multiple TCP/IP devices available)
 -s SERIAL                use device with given serial (overrides $ANDROID_SERIAL)
 -t ID                    use device with given transport id
 -H                       name of adb server host [default=localhost]
 -P                       port of adb server [default=5037]
 -L SOCKET                listen on given socket for adb server [default=tcp:localhost:5037]
 --one-device SERIAL|USB  only allowed with 'start-server' or 'server nodaemon', server will only connect to one USB device, specified by a serial number or USB device address.
 --exit-on-write-error    exit if stdout is closed

general commands:
 devices [-l]             list connected devices (-l for long output)
 help                     show this help message
 version                  show version num

networking:
 connect HOST[:PORT]      connect to a device via TCP/IP [default port=5555]
 disconnect [HOST[:PORT]]
     disconnect from given TCP/IP device [default port=5555], or all
 pair HOST[:PORT] [PAIRING CODE]
     pair with a device for secure TCP/IP communication
 forward --list           list all forward socket connections
 forward [--no-rebind] LOCAL REMOTE
     forward socket connection using:
       tcp:<port> (<local> may be "tcp:0" to pick any open port)
       localabstract:<unix domain socket name>
       localreserved:<unix domain socket name>
       localfilesystem:<unix domain socket name>
       dev:<character device name>
       dev-raw:<character device name> (open device in raw mode)
       jdwp:<process pid> (remote only)
       vsock:<CID>:<port> (remote only)
       acceptfd:<fd> (listen only)
 forward --remove LOCAL   remove specific forward socket connection
 forward --remove-all     remove all forward socket connections
 reverse --list           list all reverse socket connections from device
 reverse [--no-rebind] REMOTE LOCAL
     reverse socket connection using:
       tcp:<port> (<remote> may be "tcp:0" to pick any open port)
       localabstract:<unix domain socket name>
       localreserved:<unix domain socket name>
       localfilesystem:<unix domain socket name>
 reverse --remove REMOTE  remove specific reverse socket connection
 reverse --remove-all     remove all reverse socket connections from device
 mdns check               check if mdns discovery is available
 mdns services            list all discovered services

file transfer:
 push [--sync] [-z ALGORITHM] [-Z] LOCAL... REMOTE
     copy local files/directories to device
     -n: dry run: push files to device without storing to the filesystem
     -q: suppress progress messages
     -Z: disable compression
     -z: enable compression with a specified algorithm (any/none/brotli/lz4/zstd)
     --sync: only push files that have different timestamps on the host than the device
 pull [-a] [-z ALGORITHM] [-Z] REMOTE... LOCAL
     copy files/dirs from device
     -a: preserve file timestamp and mode
     -q: suppress progress messages
     -Z: disable compression
     -z: enable compression with a specified algorithm (any/none/brotli/lz4/zstd)
 sync [-l] [-z ALGORITHM] [-Z] [all|data|odm|oem|product|system|system_ext|vendor]
     sync a local build from $ANDROID_PRODUCT_OUT to the device (default all)
     -l: list files that would be copied, but don't copy them
     -n: dry run: push files to device without storing to the filesystem
     -q: suppress progress messages
     -Z: disable compression
     -z: enable compression with a specified algorithm (any/none/brotli/lz4/zstd)

shell:
 shell [-e ESCAPE] [-n] [-Tt] [-x] [COMMAND...]
     run remote shell command (interactive shell if no command given)
     -e: choose escape character, or "none"; default '~'
     -n: don't read from stdin
     -T: disable pty allocation
     -t: allocate a pty if on a tty (-tt: force pty allocation)
     -x: disable remote exit codes and stdout/stderr separation
 emu COMMAND              run emulator console command

app installation (see also `adb shell cmd package help`):
 install [-lrtsdg] [--instant] PACKAGE
     push a single package to the device and install it
 install-multiple [-lrtsdpg] [--instant] PACKAGE...
     push multiple APKs to the device for a single package and install them
 install-multi-package [-lrtsdpg] [--instant] PACKAGE...
     push one or more packages to the device and install them atomically
     -r: replace existing application
     -t: allow test packages
     -d: allow version code downgrade (debuggable packages only)
     -p: partial application install (install-multiple only)
     -g: grant all runtime permissions
     --abi ABI: override platform's default ABI
     --instant: cause the app to be installed as an ephemeral install app
     --no-streaming: always push APK to device and invoke Package Manager as separate steps
     --streaming: force streaming APK directly into Package Manager
     --fastdeploy: use fast deploy
     --no-fastdeploy: prevent use of fast deploy
     --force-agent: force update of deployment agent when using fast deploy
     --date-check-agent: update deployment agent when local version is newer and using fast deploy
     --version-check-agent: update deployment agent when local version has different version code and using fast deploy
     --local-agent: locate agent files from local source build (instead of SDK location)
     (See also `adb shell pm help` for more options.)
 uninstall [-k] PACKAGE
     remove this app package from the device
     '-k': keep the data and cache directories

debugging:
 bugreport [PATH]
     write bugreport to given PATH [default=bugreport.zip];
     if PATH is a directory, the bug report is saved in that directory.
     devices that don't support zipped bug reports output to stdout.
 jdwp                     list pids of processes hosting a JDWP transport
 logcat                   show device log (logcat --help for more)

security:
 disable-verity           disable dm-verity checking on userdebug builds
 enable-verity            re-enable dm-verity checking on userdebug builds
 keygen FILE
     generate adb public/private key; private key stored in FILE,

scripting:
 wait-for[-TRANSPORT]-STATE...
     wait for device to be in a given state
     STATE: device, recovery, rescue, sideload, bootloader, or disconnect
     TRANSPORT: usb, local, or any [default=any]
 get-state                print offline | bootloader | device
 get-serialno             print <serial-number>
 get-devpath              print <device-path>
 remount [-R]
      remount partitions read-write. if a reboot is required, -R will
      will automatically reboot the device.
 reboot [bootloader|recovery|sideload|sideload-auto-reboot]
     reboot the device; defaults to booting system image but
     supports bootloader and recovery too. sideload reboots
     into recovery and automatically starts sideload mode,
     sideload-auto-reboot is the same but reboots after sideloading.
 sideload OTAPACKAGE      sideload the given full OTA package
 root                     restart adbd with root permissions
 unroot                   restart adbd without root permissions
 usb                      restart adbd listening on USB
 tcpip PORT               restart adbd listening on TCP on PORT

internal debugging:
 start-server             ensure that there is a server running
 kill-server              kill the server if it is running
 reconnect                kick connection from host side to force reconnect
 reconnect device         kick connection from device side to force reconnect
 reconnect offline        reset offline/unauthorized devices to force reconnect

usb:
 attach                   attach a detached USB device
 detach                   detach from a USB device to allow use by other processes
environment variables:
 $ADB_TRACE
     comma/space separated list of debug info to log:
     all,adb,sockets,packets,rwx,usb,sync,sysdeps,transport,jdwp,services,auth,fdevent,shell,incremental
 $ADB_VENDOR_KEYS         colon-separated list of keys (files or directories)
 $ANDROID_SERIAL          serial number to connect to (see -s)
 $ANDROID_LOG_TAGS        tags to be used by logcat (see logcat --help)
 $ADB_LOCAL_TRANSPORT_MAX_PORT max emulator scan port (default 5585, 16 emus)
 $ADB_MDNS_AUTO_CONNECT   comma-separated list of mdns services to allow auto-connect (default adb-tls-connect)

Online documentation: https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/user/adb.1.md tool, so this one place leaves the device and context optional. */
async function passthroughOf(
  rules: PassthroughRules,
  args: readonly string[],
  context?: PassthroughContext,
  device?: Parameters<PassthroughRules["passthrough"]>[0],
): Promise<{ readonly args: readonly string[]; readonly command: string; readonly env: object }> {
  return await rules.passthrough(device, args, context);
}

// why: a part of a decomposed module (ADR 0063) is tested through its own surface: the rules refuse or
// serve adb arguments before any process runs, so these build the part directly.
describe("PassthroughRules", () => {
  it("fills an emulator's serial into an adb command that names no device", async () => {
    const driver = rulesFor();
    const emulator = {
      address: "emulator-5554",
      deviceId: "device",
      driverData: {},
      physical: false,
    } as const;
    const scoped = ["-P", String(adbServerPort)];
    const cases: readonly (readonly [readonly string[], readonly string[]])[] = [
      [
        ["shell", "getprop"],
        ["-s", "emulator-5554", "shell", "getprop"],
      ],
      [
        ["install", "app.apk"],
        ["-s", "emulator-5554", "install", "app.apk"],
      ],
      [
        ["reverse", "--list"],
        ["-s", "emulator-5554", "reverse", "--list"],
      ],
      [
        ["-s", "emulator-5554", "shell", "getprop"],
        ["-s", "emulator-5554", "shell", "getprop"],
      ],
      [["devices"], ["devices"]],
      [["version"], ["version"]],
      [["--version"], ["--version"]],
      [
        ["forward", "--list"],
        ["forward", "--list"],
      ],
      [
        ["reconnect", "offline"],
        ["reconnect", "offline"],
      ],
    ];

    for (const [args, expected] of cases) {
      expect((await passthroughOf(driver, args, { hasTerminal: false }, emulator)).args).toEqual([
        ...scoped,
        ...expected,
      ]);
    }
  });

  it("refuses an emulator adb command that names another device, or that runs on another platform", async () => {
    const driver = rulesFor();
    const emulator = {
      address: "emulator-5554",
      deviceId: "device",
      driverData: {},
      physical: false,
    } as const;
    const context = { hasTerminal: false, platform: "android" } as const;
    const refusal = (command: string, named: string) =>
      `Refusing \`adb ${command}\`: it names device ${named}, and this lease holds emulator-5554. Leave the device out; Simlock fills it in.`;
    const cases: readonly (readonly [readonly string[], string])[] = [
      [
        ["-s", "emulator-5556", "shell", "getprop"],
        refusal("-s emulator-5556 shell getprop", "-s emulator-5556"),
      ],
      [["-e", "shell", "getprop"], refusal("-e shell getprop", "-e")],
      [["-d", "shell", "getprop"], refusal("-d shell getprop", "-d")],
      [["-t", "3", "shell", "getprop"], refusal("-t 3 shell getprop", "-t 3")],
      [["-t3", "shell", "getprop"], refusal("-t3 shell getprop", "-t3")],
      [
        ["-t", "emulator-5554", "shell", "getprop"],
        refusal("-t emulator-5554 shell getprop", "-t emulator-5554"),
      ],
    ];

    for (const [args, message] of cases) {
      await expect(passthroughOf(driver, args, context, emulator)).rejects.toMatchObject({
        message,
        tool: "adb",
      });
    }
    await expect(
      passthroughOf(
        driver,
        ["shell", "getprop"],
        { hasTerminal: false, platform: "ios" },
        emulator,
      ),
    ).rejects.toMatchObject({
      message:
        "Refusing `adb`: it only serves an Android device, and this lease is on the ios platform.",
      tool: "adb",
    });
  });

  it("rejects a refusal with PassthroughRefusedError naming adb, never throwing it synchronously", async () => {
    const driver = rulesFor();
    const returned = driver.passthrough(undefined, ["kill-server"]);

    expect(returned).toBeInstanceOf(Promise);
    await expect(returned).rejects.toMatchObject({ tool: "adb" });
    await expect(returned).rejects.toBeInstanceOf(PassthroughRefusedError);
  });

  it("refuses kill-server, which would detach every leased emulator at once", async () => {
    const driver = rulesFor();

    await expect(passthroughOf(driver, ["kill-server"])).rejects.toThrow(PassthroughRefusedError);
    await expect(passthroughOf(driver, ["kill-server"])).rejects.toThrow(/simlock release/);
  });

  it("refuses kill-server behind a global flag, not only in first position", async () => {
    const driver = rulesFor();

    // why: Every other case passes it first, so an `args[0] === "kill-server"` rule would pass
    // them all; this is the one that holds the documented "anywhere in the arguments".
    await expect(passthroughOf(driver, ["-P", "1", "kill-server"])).rejects.toThrow(
      PassthroughRefusedError,
    );
  });

  it("refuses adb disconnect with or without an address, on the local CLI and through device.exec", async () => {
    // why: #1168. adb's server answers an empty `host:disconnect:` with kick_all_tcp_devices(),
    // which kicks every kTransportLocal transport, and emulators are local transports; with an
    // address it kicks the transport of that serial. Either way it detaches leases other than
    // the caller's, as `kill-server` would. `-s` does not scope it: the subcommand acts on no
    // device.
    const driver = rulesFor();
    const emulator = {
      address: "emulator-5554",
      deviceId: "device",
      driverData: {},
      physical: false,
    } as const;
    const callers = [
      ["local CLI", undefined, undefined],
      ["device.exec", { hasTerminal: false, platform: "android" }, emulator],
    ] as const;
    const commands = [
      ["disconnect"],
      ["-s", "emulator-5554", "disconnect"],
      ["disconnect", "emulator-5556"],
    ];

    for (const [caller, context, device] of callers) {
      for (const args of commands) {
        const returned = passthroughOf(driver, args, context, device);
        await expect(returned, `${caller}: adb ${args.join(" ")}`).rejects.toBeInstanceOf(
          PassthroughRefusedError,
        );
        await expect(returned, `${caller}: adb ${args.join(" ")}`).rejects.toMatchObject({
          message: expect.stringMatching(/^Refusing `simlock adb disconnect`/),
          tool: "adb",
        });
      }

      // why: the refusal is of the subcommand only; `disconnect` as a later argument is data.
      for (const args of [
        ["shell", "echo", "disconnect"],
        ["-s", "emulator-5554", "shell", "echo", "disconnect"],
      ]) {
        const passed = await passthroughOf(driver, args, context, device);
        expect(passed.args.slice(-args.length), `${caller}: adb ${args.join(" ")}`).toEqual(args);
      }
    }
  });

  it.each([[["emu", "avd", "stop"]], [["-s", "emulator-5586", "emu", "avd", "stop"]]])(
    "refuses an emu avd stop that would stop a device Simlock believes is running: %j",
    async (args) => {
      const driver = rulesFor();

      await expect(passthroughOf(driver, args)).rejects.toThrow(PassthroughRefusedError);
      await expect(passthroughOf(driver, args)).rejects.toThrow(/simlock release/);
    },
  );

  it("refuses every emu avd snapshot subcommand except list, since the boot snapshot is what later leases start from", async () => {
    const driver = rulesFor();

    for (const [args, reason] of [
      [["emu", "avd", "snapshot", "delete", "default_boot"], /replace or destroy/],
      [["emu", "avd", "snapshot", "del", "default_boot"], /replace or destroy/],
      [["emu", "avd", "snapshot", "save", "simlock_boot"], /replace or destroy/],
      [["emu", "avd", "snapshot", "save", "my_snapshot"], /replace or destroy/],
      [["emu", "avd", "snapshot", "push", "x", "/tmp/x"], /replace or destroy/],
      [["emu", "avd", "snapshot", "pull", "x", "/tmp/x"], /replace or destroy/],
      [["emu", "avd", "snapshot", "remap", "1"], /replace or destroy/],
      [["emu", "avd", "snapshot", "load", "x"], /replace or destroy/],
      [["emu", "avd", "snapshot", "frobnicate"], /replace or destroy/],
      [["emu", "avd", "snapshot"], /replace or destroy/],
      [["emu", "avd snapshot"], /replace or destroy/],
      [["-s", "emulator-5586", "emu", "avd", "snapshot", "save", "x"], /replace or destroy/],
      // why: adb joins the `emu` operands with spaces, so one argument may carry several words.
      [["emu", "avd snapshot save x"], /replace or destroy/],
      [["emu", "avd", "snapshot save x"], /replace or destroy/],
      [["emu", "avd snapshot push x y"], /replace or destroy/],
      [["emu", "AVD", "Snapshot", "Save", "x"], /replace or destroy/],
      [["emu", "AVD", "Snapshot", "DEL", "x"], /replace or destroy/],
      [["emu", "avd snapshot list\navd snapshot save x"], /replace or destroy/],
      [["emu", "kill"], /simlock cleanup/],
      [["emu", "avd stop"], /simlock release/],
    ] as const) {
      const label = `adb ${args.join(" ")}`;
      await expect(passthroughOf(driver, [...args]), label).rejects.toThrow(
        PassthroughRefusedError,
      );
      await expect(passthroughOf(driver, [...args]), label).rejects.toThrow(reason);
    }

    const listed = await passthroughOf(driver, ["emu", "avd", "snapshot", "list"]);
    expect(listed.args.slice(-4)).toEqual(["emu", "avd", "snapshot", "list"]);

    // why: only console operands after `emu` are matched; a device shell argument is not one.
    const shelled = await passthroughOf(driver, ["shell", "echo", "emu kill"]);
    expect(shelled.args.slice(-3)).toEqual(["shell", "echo", "emu kill"]);
  });

  it("refuses an emu kill pair even behind the -s serial that targets a device", async () => {
    const driver = rulesFor();

    await expect(passthroughOf(driver, ["-s", "emulator-5586", "emu", "kill"])).rejects.toThrow(
      PassthroughRefusedError,
    );
    await expect(passthroughOf(driver, ["-s", "emulator-5586", "emu", "kill"])).rejects.toThrow(
      /simlock cleanup/,
    );
  });

  it("refuses a caller-supplied server flag in the globals, in every spelling adb accepts, and any global it does not recognize", async () => {
    // why: `adb` takes the *last* `-P` on the line, so a caller-supplied one silently wins over the
    // one this driver inserts and the command lands on whatever server that names -- the
    // machine's default one included, which is outside Simlock's containment entirely (safety
    // rule 9). Same hole `--set`/`--profiles` closes on the iOS side, same answer.
    //
    // The attached spellings matter most: adb parses `-P` with `strncmp(argv[0], "-P", 2)`, so
    // `-P5037` is a normal way to write it, and a whole-word check would have refused the
    // separated form while passing the one that actually escapes.
    const driver = rulesFor();

    for (const args of [
      ["-P", "5037", "devices"],
      ["-P5037", "devices"],
      ["-P=5037", "devices"],
      ["--server-port", "5037", "devices"],
      ["-H", "other-host", "devices"],
      ["-Hother-host", "devices"],
      ["-L", "tcp:127.0.0.1:5037", "devices"],
      ["-s", "emulator-5554", "-P5037", "shell", "getprop"],
      // why: `--reply-fd` is a real, value-taking adb global absent from `adb --help` (confirmed
      // against the adb binary: it errors `--reply-fd requires an argument`, not `unknown
      // command`). A scanner that assumes an unrecognized flag takes no value reads its value
      // (`9`) as the subcommand and never notices the `-H`/`-P` that follow -- the exact
      // bypass this allow-list scan closes by refusing anything it does not recognize.
      ["--reply-fd", "9", "-H", "attacker.example", "-P", "5037", "shell", "id"],
      // why: Other real adb globals this driver has no reason to allow through, none of which may
      // silently terminate the scan either: an unrecognized flag is refused on sight, not
      // treated as ending the globals region.
      ["-a", "devices"],
      ["--exit-on-write-error", "devices"],
      ["--one-device", "usb:1", "devices"],
      // why: A wholly invented flag stands in for "the next adb release adds one": this list must
      // refuse what it has never seen, not just what it already knows to refuse.
      ["--not-a-real-adb-flag", "devices"],
      // why: adb answers `--version`/`--help` and exits without looking at the rest of the line, so
      // this scan cannot vouch for anything after one and must not wave a caller-supplied
      // `-P`/`-H` through behind either flag; they are safe only alone (allowed below).
      ["--version", "-P", "5037", "shell", "id"],
      ["--help", "-H", "evil", "shell", "id"],
    ]) {
      await expect(passthroughOf(driver, args), args.join(" ")).rejects.toThrow(
        PassthroughRefusedError,
      );
      await expect(
        passthroughOf(driver, args, { hasTerminal: false }),
        args.join(" "),
      ).rejects.toThrow(/supplies the adb server itself/);
    }

    // why: Past the subcommand every argument is that subcommand's operand, so one that merely
    // looks like a global travels through: refusing `echo -Please` would break a working
    // command to prevent nothing.
    for (const args of [
      ["shell", "echo", "-Please"],
      ["shell", "getprop", "-P5037"],
      ["-s", "emulator-5554", "devices"],
      ["-t", "1", "devices"],
      ["-t1", "devices"],
      ["-d", "devices"],
      ["-e", "devices"],
      // why: `--version` and `--help` answer on their own before adb ever looks for a subcommand,
      // so this scan treats them as the subcommand rather than as a global with an arity.
      ["--version"],
      ["--help"],
    ]) {
      expect((await passthroughOf(driver, args)).args, args.join(" ")).toEqual([
        "-P",
        String(adbServerPort),
        ...args,
      ]);
    }
  });

  it("refuses a bare `adb shell` only where the caller has no terminal, never merely because `shell` is the last word", async () => {
    // why: ADR 0005 §19c: `device.exec` runs the command on this machine with pipes and no pty, so
    // an interactive shell there is a process reading a pipe nothing will ever write to --
    // it would hang until `exec.timeoutMs` killed it. Locally, where the CLI hands the tool
    // its own tty, it is exactly the command a lease holder wants, so it stays allowed.
    const driver = rulesFor();

    await expect(passthroughOf(driver, ["shell"], { hasTerminal: false })).rejects.toThrow(
      PassthroughRefusedError,
    );
    await expect(passthroughOf(driver, ["shell"], { hasTerminal: false })).rejects.toThrow(
      /terminal/,
    );
    await expect(
      passthroughOf(driver, ["-s", "emulator-5586", "shell"], { hasTerminal: false }),
    ).rejects.toThrow(PassthroughRefusedError);

    // why: A shell with something to run is not the interactive shell, and neither is anything
    // else -- the refusal is about the missing command, not about `shell`. Round 4, F2: this
    // is the case the naive "does the line end in the word `shell`" check got wrong -- every
    // one of these genuinely ends in `shell`, but as an operand of an earlier subcommand
    // (`shell`, `push`), never as the bare subcommand itself, so none of them is the
    // interactive shell this refusal exists for.
    expect(
      (await passthroughOf(driver, ["shell", "getprop"], { hasTerminal: false })).args,
    ).toEqual(["-P", String(adbServerPort), "shell", "getprop"]);
    expect((await passthroughOf(driver, ["devices"], { hasTerminal: false })).args).toContain(
      "devices",
    );
    for (const args of [
      ["shell", "echo", "shell"],
      ["shell", "input", "text", "shell"],
      ["shell", "shell"],
      ["push", "./x", "shell"],
    ]) {
      expect(
        (await passthroughOf(driver, args, { hasTerminal: false })).args,
        args.join(" "),
      ).toEqual(["-P", String(adbServerPort), ...args]);
    }

    expect((await passthroughOf(driver, ["shell"], { hasTerminal: true })).args).toEqual([
      "-P",
      String(adbServerPort),
      "shell",
    ]);
    expect((await passthroughOf(driver, ["shell"])).args).toContain("shell");
  });

  it("proxies the emu subcommands that do not stop a device", async () => {
    const driver = rulesFor();

    for (const subcommand of [
      ["emu", "avd", "name"],
      ["emu", "avd", "snapshot", "list"],
    ]) {
      expect((await passthroughOf(driver, subcommand)).args, subcommand.join(" ")).toEqual([
        "-P",
        String(adbServerPort),
        ...subcommand,
      ]);
    }
  });
});
