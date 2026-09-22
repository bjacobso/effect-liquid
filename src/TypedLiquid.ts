import { Effect } from "effect";
import * as Check from "./Check.js";
import type { ParseOptions } from "./Lexer.js";
import * as Parser from "./Parser.js";
import * as Render from "./Render.js";
import type { Type } from "./Type.js";

type Paths<T, Depth extends readonly unknown[] = []> = Depth["length"] extends 6
  ? never
  : {
      [K in keyof T & string]:
        | K
        | (NonNullable<T[K]> extends readonly unknown[]
            ? never
            : NonNullable<T[K]> extends object
              ? `${K}.${Paths<NonNullable<T[K]>, [...Depth, unknown]>}`
              : never);
    }[keyof T & string];

type PathValue<T, P extends string> = P extends `${infer Key}.${infer Rest}`
  ? Key extends keyof T
    ? PathValue<NonNullable<T[Key]>, Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

const fragmentBrand = Symbol("effect-liquid/typed-expression");
interface Fragment {
  readonly [fragmentBrand]: true;
  readonly source: string;
}

/** A Liquid expression with a TypeScript result type. */
export class Expression<T> implements Fragment {
  declare private readonly invariant: (value: T) => T;
  readonly [fragmentBrand] = true;

  private constructor(readonly source: string) {}

  static path<T>(source: string): Expression<T> {
    if (!/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*$/.test(source))
      throw new Error(`Invalid Liquid path: ${source}`);
    return new Expression<T>(source);
  }

  upcase(this: Expression<string>): Expression<string> {
    return new Expression<string>(`${this.source} | upcase`);
  }

  downcase(this: Expression<string>): Expression<string> {
    return new Expression<string>(`${this.source} | downcase`);
  }

  escape(): Expression<string> {
    return new Expression<string>(`${this.source} | escape`);
  }

  size<U extends string | readonly unknown[]>(this: Expression<U>): Expression<number> {
    return new Expression<number>(`${this.source} | size`);
  }
}

/** A template whose render input is checked by TypeScript. */
export class Template<Context extends object> {
  constructor(readonly source: string) {}

  parse(options?: ParseOptions) {
    return Parser.parse(this.source, options);
  }

  render(context: Context, options?: ParseOptions) {
    return Effect.flatMap(this.parse(options), (document) => Render.render(document, context));
  }

  check(contract: Type, options?: ParseOptions) {
    return Effect.flatMap(this.parse(options), (document) => Check.check(document, contract));
  }
}

/** Build Liquid templates with typed external paths and expression holes. */
export function liquid<Context extends object>() {
  return {
    path<P extends Paths<Context>>(path: P): Expression<PathValue<Context, P>> {
      return Expression.path<PathValue<Context, P>>(path);
    },
    template(strings: TemplateStringsArray, ...fragments: readonly Fragment[]): Template<Context> {
      let source = strings[0] ?? "";
      for (let i = 0; i < fragments.length; i++) {
        if (fragments[i]?.[fragmentBrand] !== true)
          throw new TypeError("Liquid template holes must be typed expressions");
        source += fragments[i]!.source + (strings[i + 1] ?? "");
      }
      return new Template<Context>(source);
    },
  };
}
