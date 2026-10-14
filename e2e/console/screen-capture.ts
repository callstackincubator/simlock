import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

// why: the browser lane needs a capture program to point a daemon's `stream.command` at, and the real
// one is Swift, needs a booted simulator, and cannot run on a CI runner. This writes the same envelope
// that tool writes -- a meta frame naming `mjpeg`, then one JPEG per delta frame -- from a process that
// owes its life to nothing but the daemon that started it. Stills rather than H.264 so the lane decodes
// in every browser, WebCodecs being Chromium's for now; the H.264 path is pinned by unit tests.

// why: three solid-colour stills -- red, lime, blue, made by
// `ffmpeg -f lavfi -i color=red:s=120x240 -frames:v 1 -q:v 30 f.jpg` -- held as base64 so the program
// below turns them back into bytes with no fixture file to ship. They differ because the lane asserts
// the pane shows a picture that *changes*, and one colour painted twice is not a change.
const STILLS = [
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMAD/2wBDAAg8PEc8R1JSUlJSUmFaYWVlZWFhYWFlZWVsbGx/f39sbGxlZWxseHh/f4qOioODf4OOjpaWlrS0rKzS0tn/////xABNAAEBAAAAAAAAAAAAAAAAAAAABgEBAQEAAAAAAAAAAAAAAAAAAAYHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgA8AB4AwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AiwEo38AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/9k=",
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMAD/2wBDAAg8PEc8R1JSUlJSUmFaYWVlZWFhYWFlZWVsbGx/f39sbGxlZWxseHh/f4qOioODf4OOjpaWlrS0rKzS0tn/////xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAAAAYQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCADwAHgDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLASqJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf/2Q==",
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMAD/2wBDAAg8PEc8R1JSUlJSUmFaYWVlZWFhYWFlZWVsbGx/f39sbGxlZWxseHh/f4qOioODf4OOjpaWlrS0rKzS0tn/////xABNAAEBAAAAAAAAAAAAAAAAAAAABwEBAQEAAAAAAAAAAAAAAAAAAAUHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgA8AB4AwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AjgDf0sAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/9k=",
];

export async function writeCaptureProgram(dir: string): Promise<string> {
  const path = join(dir, "mjpeg-capture.mjs");
  await writeFile(
    path,
    `#!/usr/bin/env node
// why: the lane's stand-in for simlock's screen capture program. It writes the same envelope, exits
// when the daemon closes its stdin, and logs when it was started and when it went away -- which is how
// the lane proves a viewer leaving or a lease ending stops a capture rather than only a picture.
import { appendFileSync } from "node:fs";

const LOG = ${JSON.stringify(join(dir, "capture.log"))};
const args = process.argv.slice(2);
const address = args.at(-1);
const stills = ${JSON.stringify(STILLS)}.map((text) => Buffer.from(text, "base64"));

function envelope(tag, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length + 1, 0);
  head[4] = tag;
  return Buffer.concat([head, payload]);
}

const meta = Buffer.from(
  JSON.stringify({ udid: address, codec: "mjpeg", width: 120, height: 240, fps: 5, deviceSet: "lane" }),
);

appendFileSync(LOG, \`opened \${JSON.stringify(args)}\\n\`);
process.stdout.write(envelope(0x05, meta));

let next = 0;
const timer = setInterval(() => {
  process.stdout.write(envelope(0x03, stills[next++ % stills.length]));
}, 100);

// why: stdin is the liveness handle the real tool documents, so an "end" on it is the one stop a
// daemon gives a capture, and the line below is the lane's evidence that the request was what held it.
process.stdin.on("end", () => {
  appendFileSync(LOG, "closed\\n");
  clearInterval(timer);
  process.exit(0);
});
process.stdin.resume();
process.stdout.on("error", () => process.exit(0));
`,
  );
  await chmod(path, 0o755);
  return path;
}

export async function captureLog(dir: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(join(dir, "capture.log"), "utf8").catch(() => "");
}
