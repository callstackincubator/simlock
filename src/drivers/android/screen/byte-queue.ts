export class ByteQueue {
  readonly #chunks: Uint8Array[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#length += chunk.length;
  }

  take(count: number): Uint8Array {
    if (count > this.#length) throw new RangeError("ByteQueue.take past its end");
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const head = this.#chunks[0];
      if (head === undefined) break;
      const used = Math.min(head.length, count - filled);
      out.set(head.subarray(0, used), filled);
      filled += used;
      if (used === head.length) this.#chunks.shift();
      else this.#chunks[0] = head.subarray(used);
    }
    this.#length -= count;
    return out;
  }

  drain(): Uint8Array {
    return this.take(this.#length);
  }
}
