import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { captureStream } from "./capture.js";

// why: these tests spawn real programs rather than faking the spawn, because the whole point of this
// module is how it treats a child process -- its stdin, its stdout mid-chunk, its death -- and a fake
// child proves the arrangement of the fake.
const dirs: string[] = [];

async function program(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "simlock-capture-"));
  dirs.push(dir);
  const path = join(dir, "capture.mjs");
  await writeFile(path, `#!/usr/bin/env node\n${source}`);
  await chmod(path, 0o755);
  return path;
}

afterAll(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

function frame(tag: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length + 1, 0);
  head[4] = tag;
  return Buffer.concat([head, payload]);
}

function metaFrame(): Buffer {
  return frame(0x05, Buffer.from(JSON.stringify({ codec: "h264", fps: 30, height: 720, width: 330 })));
}

function collect(body: ReadableStream<Uint8Array>, bytes: number): Promise<Uint8Array> {
  return (async () => {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let have = 0;
    while (have < bytes) {
      const step = await reader.read();
      if (step.done) break;
      chunks.push(step.value);
      have += step.value.length;
    }
    await reader.cancel().catch(() => undefined);
    return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  })();
}

describe("captureStream", () => {
  it("waits for the meta frame and hands the body back from its first byte", async () => {
    const command = await program(`
      const meta = ${JSON.stringify([...metaFrame()])};
      process.stdout.write(Buffer.from(meta));
      setInterval(() => process.stdout.write(Buffer.from([1,2,3])), 10);
      process.stdin.resume();
    `);
    const stream = await captureStream({ args: [], command, env: process.env });

    expect(stream.meta).toEqual({ codec: "h264", fps: 30, height: 720, width: 330 });
    // why: the meta frame is the head's answer, and a decoder still needs it in the body -- a reader
    // that got only [1,2,3] lost the frame that says how to read them.
    const first = await collect(stream.body, metaFrame().length + 3);
    expect(Buffer.from(first.subarray(0, metaFrame().length)).equals(metaFrame())).toBe(true);
    expect([...first.subarray(metaFrame().length)]).toEqual([1, 2, 3]);
    stream.close();
  });

  it("keeps the bytes that arrived in the same read as the meta frame", async () => {
    // why: one write of meta-and-frames-together is what a pipe does under load, and a scanner that
    // returned only the meta frame would drop every frame that shared the read with it.
    const whole = Buffer.concat([metaFrame(), frame(0x03, Buffer.from([9, 9, 9]))]);
    const command = await program(`
      process.stdout.write(Buffer.from(${JSON.stringify([...whole])}));
      process.stdin.resume();
    `);
    const stream = await captureStream({ args: [], command, env: process.env });
    expect([...(await collect(stream.body, whole.length))]).toEqual([...whole]);
    stream.close();
  });

  it("reads a meta frame that arrives a few bytes at a time", async () => {
    const command = await program(`
      const bytes = Buffer.from(${JSON.stringify([...metaFrame()])});
      let at = 0;
      const timer = setInterval(() => {
        process.stdout.write(bytes.subarray(at, at + 2));
        at += 2;
        if (at >= bytes.length) clearInterval(timer);
      }, 2);
      process.stdin.resume();
    `);
    const stream = await captureStream({ args: [], command, env: process.env });
    expect(stream.meta.width).toBe(330);
    stream.close();
  });

  it("stops the tool the way the tool was built to be stopped, and says so exactly once", async () => {
    // why: the claim is that the child sees its stdin close -- the liveness handle the capture program
    // is written against -- and not merely that this process forgot about it. A tool that ignored stdin
    // would keep filming, and only reading what the child itself wrote proves it stopped.
    const dir = await mkdtemp(join(tmpdir(), "simlock-capture-"));
    dirs.push(dir);
    const seen = join(dir, "stdin-ended");
    const command = await program(`
      import { writeFileSync } from "node:fs";
      process.stdout.write(Buffer.from(${JSON.stringify([...metaFrame()])}));
      process.stdin.on("end", () => writeFileSync(${JSON.stringify(seen)}, "ended"));
      process.stdin.resume();
    `);
    let ended = 0;
    const stream = await captureStream({
      args: [],
      command,
      env: process.env,
      onEnd: () => {
        ended += 1;
      },
    });
    stream.close();
    stream.close();
    expect(ended).toBe(1);

    const { readFile } = await import("node:fs/promises");
    for (let at = 0; at < 100; at += 1) {
      try {
        expect(await readFile(seen, "utf8")).toBe("ended");
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    throw new Error("the capture program never saw its stdin close");
  });

  it("reports a tool that dies before its first frame, with its own words", async () => {
    const command = await program('console.error("Device not found in device set"); process.exit(1);');
    await expect(captureStream({ args: [], command, env: process.env })).rejects.toThrow(
      /not found in device set/u,
    );
  });

  it("tells whoever registered a tool that died on its own, without being asked to close it", async () => {
    const command = await program(`
      process.stdout.write(Buffer.from(${JSON.stringify([...metaFrame()])}));
      setTimeout(() => process.exit(0), 20);
    `);
    let ended = 0;
    const stream = await captureStream({
      args: [],
      command,
      env: process.env,
      onEnd: () => {
        ended += 1;
      },
    });
    const reader = stream.body.getReader();
    // why: a simulator that was shut down mid-picture ends this stream on its own; a registry still
    // naming the capture after that is a lease that looks like it still has a picture running.
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ended).toBe(1);
  });

  it("ends the capture when its body is dropped", async () => {
    const command = await program(`
      process.stdout.write(Buffer.from(${JSON.stringify([...metaFrame()])}));
      setInterval(() => process.stdout.write(Buffer.from([0])), 5);
      process.stdin.resume();
    `);
    let ended = 0;
    const stream = await captureStream({
      args: [],
      command,
      env: process.env,
      onEnd: () => {
        ended += 1;
      },
    });
    await stream.body.cancel();
    expect(ended).toBe(1);
  });

  it("gives up on a tool that starts and never writes a frame", async () => {
    const command = await program("process.stdin.resume();");
    // why: this is the failure a request could otherwise wait on forever -- a program that exists, that
    // spawned, and that has nothing to say. The bound is what turns it into an answer.
    await expect(
      captureStream({ args: [], command, env: process.env, silenceMs: 250 }),
    ).rejects.toThrow(/wrote nothing for 250ms/u);
  });

  it("ends a stream whose tool goes quiet mid-picture", async () => {
    const command = await program(`
      process.stdout.write(Buffer.from(${JSON.stringify([...metaFrame()])}));
      // why: nothing more arrives, which is the whole case under test
      process.stdin.resume();
    `);
    let ended = 0;
    const stream = await captureStream({
      args: [],
      command,
      env: process.env,
      onEnd: () => {
        ended += 1;
      },
      silenceMs: 250,
    });
    const reader = stream.body.getReader();
    // why: an errored stream rejects `closed` too, and a test that lets that escape reports an
    // unhandled rejection instead of the claim it is making.
    reader.closed.catch(() => undefined);
    // why: drained rather than read once, because the stream pulls ahead of the reader and so *which*
    // read meets the silence is not knowable here -- the claim is that reading this body cannot go on
    // forever, whichever step the bound is reported on. The race against a longer timer is what makes a
    // bound that never fired fail with a named reason instead of hanging to vitest's own timeout, and
    // the cancel inside it is what frees a read still waiting when that happens.
    const drained: Promise<string> = (async () => {
      try {
        for (;;) {
          const step = await reader.read();
          if (step.done) return "the body ended cleanly";
        }
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    const next: string = await Promise.race<string>([
      drained,
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          void reader.cancel().catch(() => undefined);
          resolve("never answered");
        }, 5_000);
        timer.unref();
      }),
    ]);
    // why: a bound that held only before the first frame would leave a viewer watching a picture that
    // froze, which is the failure mode this whole module is here to avoid.
    expect(next).toMatch(/^The screen capture produced no stream \(the capture tool wrote nothing/u);
    // why: the reader's failure and the capture's stop are two claims, and only the second keeps a
    // simulator's framebuffer from being pinned by a stream nobody can see any more.
    expect(ended).toBe(1);
  });

  it("refuses a tool that is not there rather than hanging", async () => {
    await expect(
      captureStream({
        args: [],
        command: join(tmpdir(), "simlock-no-such-capture-program"),
        env: process.env,
      }),
    ).rejects.toThrow(/simlock-no-such-capture-program/u);
  });

  it("refuses an output that is not a frame envelope", async () => {
    const command = await program(`process.stdout.write("not a stream at all\\n"); process.exit(0);`);
    await expect(captureStream({ args: [], command, env: process.env })).rejects.toThrow(
      /not a frame envelope|ended before it wrote a frame/u,
    );
  });
});
