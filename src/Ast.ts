import type { DelimiterOptions, WhitespaceOptions } from "./Lexer.js";
import type { Source, Span } from "./Source.js";
export type Dialect = "liquidjs" | "ruby";
export type LiteralValue = null | boolean | number | string;
export type Expression =
  | { readonly _tag: "Sequence"; readonly values: readonly Expression[]; readonly span: Span }
  | {
      readonly _tag: "Literal";
      readonly missing?: true;
      readonly lookupKind?: "property";
      readonly numericKind?: "integer" | "float";
      readonly value: LiteralValue;
      readonly span: Span;
    }
  | { readonly _tag: "Special"; readonly value: "empty" | "blank"; readonly span: Span }
  | {
      readonly _tag: "Access";
      readonly receiver: Expression;
      readonly segments: readonly Expression[];
      readonly span: Span;
    }
  | { readonly _tag: "SelfLookup"; readonly segments: readonly Expression[]; readonly span: Span }
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
export interface PartialBinding {
  readonly value: Expression;
  readonly alias?: string;
}
export type Node =
  | { readonly _tag: "IfChanged"; readonly body: readonly Node[]; readonly span: Span }
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
  | { readonly _tag: "Text"; readonly raw?: true; readonly value: string; readonly span: Span }
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
      readonly key: string;
      readonly loopName: string;
      readonly offsetContinue?: boolean;
      readonly name: string;
      readonly collection: Expression;
      readonly limit?: Expression;
      readonly offset?: Expression;
      readonly reversed: boolean;
      readonly modifiers?: readonly ("offset" | "limit" | "reversed")[];
      readonly body: readonly Node[];
      readonly otherwise: readonly Node[];
      readonly span: Span;
    }
  | {
      readonly _tag: "TableRow";
      readonly name: string;
      readonly loopName: string;
      readonly collection: Expression;
      readonly limit?: Expression;
      readonly offset?: Expression;
      readonly cols?: Expression;
      readonly body: readonly Node[];
      readonly span: Span;
    }
  | { readonly _tag: "Break" | "Continue"; readonly span: Span }
  | {
      readonly _tag: "Block";
      readonly name: string;
      readonly body: readonly Node[];
      readonly span: Span;
    }
  | {
      readonly _tag: "Layout";
      readonly template?: Expression;
      readonly args: Readonly<Record<string, Expression>>;
      readonly body: readonly Node[];
      readonly span: Span;
    }
  | {
      readonly _tag: "Partial";
      readonly mode: "render" | "include";
      readonly with?: PartialBinding;
      readonly for?: PartialBinding;
      readonly template: Expression;
      readonly args: Readonly<Record<string, Expression>>;
      readonly span: Span;
    };
export interface Document {
  readonly recovered?: true;
  readonly dialect?: Dialect;
  readonly errorMode?: "strict" | "strict2";
  readonly parseLimit?: number;
  readonly whitespace?: WhitespaceOptions;
  readonly delimiters?: DelimiterOptions;
  readonly groupedExpressions?: boolean;
  readonly orderedFilterParameters?: boolean;
  readonly _tag: "Document";
  readonly source: Source;
  readonly body: readonly Node[];
}
