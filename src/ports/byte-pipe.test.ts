import { describe, expect, it } from "vitest";

import { NodeBytePipeLauncher } from "./byte-pipe.js";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe("NodeBytePipeLauncher", () => {
  it("hands stdout out as the exact bytes the child wrote, including ones that are not text", async () => {
    const child = new NodeBytePipeLauncher().start(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.from([0, 255, 10, 128, 1]))"],
      { env: process.env },
    );
    expect([...(await readAll(child.stdout))]).toEqual([0, 255, 10, 128, 1]);
    expect(await child.exited).toEqual({ code: 0, signal: null });
  });

  it("closing stdin ends a child that waits on it", async () => {
    const child = new NodeBytePipeLauncher().start(
      process.execPath,
      ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(7))"],
      { env: process.env },
    );
    child.closeStdin();
    expect(await child.exited).toEqual({ code: 7, signal: null });
  });

  it("reports each stderr line once it is complete", async () => {
    const lines: string[] = [];
    const child = new NodeBytePipeLauncher().start(
      process.execPath,
      [
        "-e",
        "process.stderr.write('one\\ntw'); setTimeout(() => process.stderr.write('o\\n'), 20)",
      ],
      { env: process.env, onStderrLine: (line) => lines.push(line) },
    );
    await child.exited;
    expect(lines).toEqual(["one", "two"]);
  });

  it("resolves a program that cannot be started with the spawn error instead of rejecting", async () => {
    const child = new NodeBytePipeLauncher().start("/nonexistent/simlock-capture", [], {
      env: process.env,
    });
    const exit = await child.exited;
    expect(exit.code).toBeNull();
    expect(exit.error).toMatch(/ENOENT/);
  });

  it("kill ends a child that ignores stdin", async () => {
    const child = new NodeBytePipeLauncher().start(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { env: process.env },
    );
    child.kill("SIGKILL");
    expect(await child.exited).toEqual({ code: null, signal: "SIGKILL" });
  });
});
