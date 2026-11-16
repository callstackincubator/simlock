import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { promiseState } from "../../test-support/promise-state.js";
import {
  DEVICE_ROOT,
  Lab,
  PHONE,
  PHONE_IDENTIFIER,
  PHONE_UDID,
  READ_LIMIT_MS,
  ReadScript,
  SIMLOCK_HOME,
  UDID_A,
  UDID_B,
  enrollableLab,
  expireAfter,
  inspect,
  listDocument,
  listed,
  lockDocument,
  turns,
  waitForCalls,
  wire,
} from "./test-physical.js";

const simctlListFixture = readFileSync(
  new URL("./fixtures/simctl-list.json", import.meta.url),
  "utf8",
);

const JSON_DIR = `${SIMLOCK_HOME}/devicectl`;

describe("IosSimctlDriver physical handler: files and limits", () => {
  it("every devicectl read passes --json-output <path> naming a new file in <simlockHome>/devicectl/ (the driver creates it, mode 0700), and the driver reads that file and then deletes it", async () => {
    const lab = enrollableLab([wire(PHONE)], PHONE_UDID, ["com.example.MyApp"]);

    const result = await inspect(lab, PHONE_UDID);

    expect(result).toMatchObject({ apps: ["com.example.MyApp"], enrollable: true });
    expect(lab.written).toHaveLength(3);
    expect(new Set(lab.written).size).toBe(3);
    for (const path of lab.written) {
      expect(path).toMatch(/^\/home\/\.simlock\/devicectl\/[^/]+$/);
      expect(await lab.filesystem.exists(path)).toBe(false);
    }
    const directory = await lab.filesystem.lstat(JSON_DIR);
    expect(directory.kind).toBe("directory");
    expect(directory.mode & 0o777).toBe(0o700);
  });

  it.each([
    { expires: false, script: { exit: 1 } as ReadScript, title: "exits non-zero" },
    { expires: true, script: { hangs: true } as ReadScript, title: "passes its limit" },
  ])("the file is deleted also after a read that $title", async ({ expires, script }) => {
    const lab = new Lab().list(listDocument([wire(PHONE)]), {
      file: listDocument([wire(PHONE)]),
      ...script,
    });
    const driver = await lab.driver();

    await expireAfter(
      lab,
      driver.inspectPhysical(PHONE_UDID),
      expires ? 1 : 0,
      expires ? READ_LIMIT_MS : 0,
    );

    expect(lab.written).toHaveLength(1);
    expect(await lab.filesystem.exists(lab.written[0] ?? "")).toBe(false);
  });

  it("two lock reads in parallel name two different files", async () => {
    const lab = new Lab()
      .list([listed(UDID_A), listed(UDID_B)])
      .lock(UDID_A)
      .lock(UDID_B);

    const result = await (await lab.driver()).listPresentPhysical([UDID_A, UDID_B]);

    expect(result).toMatchObject([{ present: true }, { present: true }]);
    expect(lab.written).toHaveLength(3);
    expect(new Set(lab.written).size).toBe(3);
  });

  it.each([
    {
      lab: () =>
        new Lab()
          .list([wire(PHONE)])
          .lock(PHONE_UDID, { file: lockDocument({ passcodeRequired: "false" }) })
          .apps(PHONE_UDID, ["com.example.MyApp"]),
      name: "lockState",
      title: "passcodeRequired as a string",
    },
    {
      lab: () =>
        new Lab()
          .list([wire({ ...PHONE, udid: 8110 })])
          .lock(PHONE_UDID)
          .apps(PHONE_UDID, ["com.example.MyApp"]),
      name: "list devices",
      title: "udid as a number",
    },
  ])(
    "a read whose file holds a field of the wrong JSON type ($title) is a failed read",
    async ({ lab, name }) => {
      const accepted = await inspect(enrollableLab(), PHONE_IDENTIFIER);
      expect(accepted).toMatchObject({ enrollable: true });

      const result = await inspect(lab(), PHONE_IDENTIFIER);

      expect(result).toMatchObject({
        enrollable: false,
        message: expect.stringContaining(name),
        reason: "unreadable",
      });
    },
  );

  it("a devicectl read that hangs does not delay a simctl call made at the same time", async () => {
    const lab = new Lab().list([wire(PHONE)], { hangs: true }).add({
      match: {
        args: ["simctl", "--set", DEVICE_ROOT, "list", "-j", "devicetypes", "runtimes"],
        command: "xcrun",
      },
      result: { code: 0, stderr: "", stdout: simctlListFixture },
    });
    const driver = await lab.driver();
    const read = driver.inspectPhysical(PHONE_UDID);
    void read.catch(() => undefined);
    await waitForCalls(lab.runner, 1);
    const readState = promiseState(read);

    const resolving = driver.resolveSpec({ model: "iPhone 16", platform: "ios" });
    const resolvingState = promiseState(resolving);
    await turns(5);

    expect(readState.state).toBe("pending");
    expect(resolvingState.state).toBe("fulfilled");
    expect(await resolving).toMatchObject({ model: "iPhone 16", physical: false });
  });
});
