// why: the stream's envelope is one contract both iOS stream lanes read -- a big-endian length, a
// one-byte tag, then the payload, written by the capture programs and handed to a viewer byte for
// byte by the stream module. A lane that claims a stream carries a key frame reads it through here,
// so the two lanes cannot drift into checking two different formats.
export const SCREEN_TAGS = { description: 0x01, keyframe: 0x02, meta: 0x05 } as const;

export interface ScreenFrame {
  readonly tag: number;
  readonly payload: Uint8Array;
}

// why: the body is an endless stream, so this reads frames until it has what it came for and then
// lets go, rather than reading to an end that never comes.
export async function readScreenFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  enough: (frames: readonly ScreenFrame[]) => boolean,
): Promise<ScreenFrame[]> {
  const frames: ScreenFrame[] = [];
  let buffer = new Uint8Array(0);
  while (!enough(frames)) {
    const step = await reader.read();
    if (step.done) break;
    const joined = new Uint8Array(buffer.length + step.value.length);
    joined.set(buffer);
    joined.set(step.value, buffer.length);
    buffer = joined;
    while (buffer.length >= 5) {
      const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
      if (buffer.length < 4 + length) break;
      frames.push({ payload: buffer.slice(5, 4 + length), tag: buffer[4]! });
      buffer = buffer.slice(4 + length);
    }
  }
  return frames;
}
