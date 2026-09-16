import type { Source, Span } from "./Source.js";
export type LiteralValue = null | boolean | number | string;
export type Expression =
  | { readonly _tag: "Literal"; readonly value: LiteralValue; readonly span: Span }
  | { readonly _tag: "Special"; readonly value: "empty" | "blank"; readonly span: Span }
  | {
      readonly _tag: "Lookup";
      readonly root: string;
      readonly segments: readonly Expression[];
      readonly span: Span;
    }
  | {
      readonly _tag: "Range";
      readonly from: Expression;
      readonly to: Expression;
      readonly span: Span;
    }
  | {
      readonly _tag: "Binary";
      readonly operator: string;
      readonly left: Expression;
      readonly right: Expression;
      readonly span: Span;
    }
  | { readonly _tag: "Not"; readonly value: Expression; readonly span: Span }
  | {
      readonly _tag: "Filter";
      readonly input: Expression;
      readonly name: string;
      readonly args: readonly Expression[];
      readonly named: Readonly<Record<string, Expression>>;
      readonly span: Span;
    };
export type Node =
  | {
      readonly _tag: "Counter";
      readonly name: string;
      readonly direction: 1 | -1;
      readonly nameSpan: Span;
      readonly span: Span;
    }
  | {
      readonly _tag: "Cycle";
      readonly group?: Expression;
      readonly values: readonly Expression[];
      readonly key: string;
      readonly span: Span;
    }
  | { readonly _tag: "Text"; readonly value: string; readonly span: Span }
  | { readonly _tag: "Output"; readonly expression: Expression; readonly span: Span }
  | {
      readonly _tag: "Assign";
      readonly name: string;
      readonly expression: Expression;
      readonly span: Span;
    }
  | {
      readonly _tag: "Capture";
      readonly name: string;
      readonly body: readonly Node[];
      readonly span: Span;
    }
  | {
      readonly _tag: "If";
      readonly branches: readonly {
        readonly condition: Expression;
        readonly body: readonly Node[];
      }[];
      readonly otherwise: readonly Node[];
      readonly span: Span;
    }
  | {
      readonly _tag: "Case";
      readonly expression: Expression;
      readonly branches: readonly {
        readonly values: readonly Expression[];
        readonly body: readonly Node[];
      }[];
      readonly otherwise: readonly Node[];
      readonly span: Span;
    }
  | {
      readonly _tag: "For";
      readonly name: string;
      readonly collection: Expression;
      readonly limit?: Expression;
      readonly offset?: Expression;
      readonly reversed: boolean;
      readonly body: readonly Node[];
      readonly otherwise: readonly Node[];
      readonly span: Span;
    }
  | { readonly _tag: "Break" | "Continue"; readonly span: Span }
  | {
      readonly _tag: "Partial";
      readonly mode: "render" | "include";
      readonly template: Expression;
      readonly args: Readonly<Record<string, Expression>>;
      readonly span: Span;
    };
export interface Document {
  readonly _tag: "Document";
  readonly source: Source;
  readonly body: readonly Node[];
}
