/** Bounded framing shared by the private engine line protocol and Chromium pipe. */
export class FrameDecoder {
  private pending = Buffer.alloc(0);
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  readonly separator: number;
  readonly maxBytes: number;
  constructor(separator: number, maxBytes: number) {
    this.separator = separator;
    this.maxBytes = maxBytes;
  }

  push(chunk: Uint8Array): readonly string[] {
    const input = Buffer.concat([this.pending, chunk]);
    const frames: string[] = [];
    let offset = 0;
    for (;;) {
      const end = input.indexOf(this.separator, offset);
      if (end < 0) break;
      if (end - offset > this.maxBytes) throw new Error("Engine frame exceeds its byte limit");
      if (end > offset) frames.push(this.decoder.decode(input.subarray(offset, end)));
      offset = end + 1;
    }
    if (input.length - offset > this.maxBytes)
      throw new Error("Unterminated engine frame exceeds its byte limit");
    this.pending = Buffer.from(input.subarray(offset));
    return frames;
  }

  finish(): void {
    if (this.pending.length) throw new Error("Engine ended with an incomplete frame");
  }
}
