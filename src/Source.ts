export interface Source {
  readonly id: string;
  readonly text: string;
  readonly revision?: string;
}
export interface Span {
  readonly sourceId: string;
  readonly start: number;
  readonly end: number;
}
export const span = (sourceId: string, start: number, end: number): Span => ({
  sourceId,
  start,
  end,
});
export const make = (text: string, id = "<template>"): Source => ({ id, text });
export function location(source: Source, offset: number): { line: number; column: number } {
  offset = Number.isFinite(offset)
    ? Math.max(0, Math.min(Math.trunc(offset), source.text.length))
    : 0;
  let line = 1;
  let start = 0;
  for (let i = 0; i < Math.min(offset, source.text.length); i++) {
    if (source.text[i] === "\r") {
      if (source.text[i + 1] === "\n") {
        if (i + 1 >= offset) break;
        i++;
      }
      line++;
      start = i + 1;
    } else if (source.text[i] === "\n") {
      line++;
      start = i + 1;
    }
  }
  return { line, column: offset - start + 1 };
}
