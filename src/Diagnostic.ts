import { Data } from "effect";
import type { Span } from "./Source.js";
export interface Diagnostic {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly span: Span;
  readonly related?: readonly { readonly message: string; readonly span: Span }[];
}
export class ParseError extends Data.TaggedError("ParseError")<{
  readonly message: string;
  readonly span: Span;
}> {}
export class RenderError extends Data.TaggedError("RenderError")<{
  readonly code:
    | "MissingVariable"
    | "UnknownFilter"
    | "InvalidContext"
    | "ResourceLimitExceeded"
    | "InvalidOperation";
  readonly message: string;
  readonly span: Span;
}> {}
export class FilterFailure<E> extends Data.TaggedError("FilterFailure")<{
  readonly name: string;
  readonly cause: E;
  readonly span: Span;
}> {}
export class LoadError extends Data.TaggedError("LoadError")<{
  readonly name: string;
  readonly message: string;
}> {}
