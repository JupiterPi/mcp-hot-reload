/** Bounded FIFO of text lines, used to retain a tail of a child process's stderr. */
export class RingBuffer {
  private readonly lines: string[] = [];

  constructor(private readonly maxLines: number) {}

  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }

  tail(): string {
    return this.lines.join("\n");
  }
}
