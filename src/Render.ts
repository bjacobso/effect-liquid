import { Chunk, Context, Effect, Layer, Option, Stream } from "effect";
import type { Dialect, Document, Expression, Node } from "./Ast.js";
import { registry as builtins } from "./Builtins.js";
import {
  BuiltinFilterError,
  FilterFailure,
  type LoadError,
  ParseError,
  RenderError,
} from "./Diagnostic.js";
import { embeddedExpression } from "./EmbeddedExpression.js";
import type { DateOptions, FilterCallContext, Registry } from "./Filter.js";
import type { DelimiterOptions, WhitespaceOptions } from "./Lexer.js";
import { parse } from "./Parser.js";
import type { Span } from "./Source.js";
import { TemplateLoader } from "./TemplateLoader.js";
import {
  blank,
  empty,
  isArray,
  lookup,
  normalize,
  stringify,
  truthy,
  type Value,
} from "./Value.js";
export interface Config extends DateOptions {
  readonly memoryLimit?: number | undefined;
  readonly renderLimit?: number | undefined;
  readonly strictVariables: boolean;
  readonly strictFilters: boolean;
  readonly jekyllWhere: boolean;
  readonly lenientIf: boolean;
  readonly outputEscape: "escape" | "json" | undefined;
  readonly maxSteps: number;
  readonly maxIterations: number;
  readonly maxOutputBytes: number;
  readonly maxDepth: number;
  readonly globals: Readonly<Record<string, Value>>;
}
export const defaults: Config = {
  strictVariables: false,
  strictFilters: true,
  jekyllWhere: false,
  lenientIf: false,
  outputEscape: undefined,
  timezoneOffset: undefined,
  preserveTimezones: false,
  locale: "en-US",
  dateFormat: "%A, %B %-e, %Y at %-l:%M %P %z",
  memoryLimit: undefined,
  renderLimit: undefined,
  maxSteps: 1_000_000,
  maxIterations: 100_000,
  maxOutputBytes: 10_000_000,
  maxDepth: 64,
  globals: {},
};
export class RenderConfig extends Context.Tag("effect-liquid/RenderConfig")<
  RenderConfig,
  Config
>() {}
export const layer = (config: Partial<Config> = {}) =>
  Layer.succeed(RenderConfig, { ...defaults, ...config });
interface State {
  dialect: Dialect;
  whitespace: WhitespaceOptions & { readonly parseLimit?: number };
  delimiters: DelimiterOptions;
  groupedExpressions: boolean;
  orderedFilterParameters: boolean;
  scopes: Record<string, Value | undefined>[];
  cycles: Map<string, number>;
  continuations: Map<string, number>;
  steps: number;
  iterations: number;
  outputBytes: number;
  allocationUnits: number;
  control: "break" | "continue" | undefined;
  depth: number;
  filterDepth: number;
  lenientDepth: number;
  layoutStore: boolean;
  layoutBlocks: Map<string, readonly Node[]>;
  config: Config;
}
type Failure<E> = RenderError | ParseError | LoadError | FilterFailure<E | BuiltinFilterError>;
// The interpreter yields only at Effect boundaries. Ordinary AST evaluation stays on
// the current stack; both render drivers share these instructions and accounting.
type Evaluation<A, E, R> = Generator<Effect.Effect<unknown, Failure<E>, R>, A, unknown>;
type Rendering<E, R> = Generator<
  string | Effect.Effect<unknown, Failure<E>, R | TemplateLoader>,
  void,
  unknown
>;
function* perform<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Generator<Effect.Effect<unknown, E, R>, A, unknown> {
  return (yield effect) as A;
}
function* tick(state: State, at: Span): Evaluation<void, never, never> {
  if (++state.steps > state.config.maxSteps)
    yield* perform(
      Effect.fail(
        new RenderError({
          code: "ResourceLimitExceeded",
          message: "Work limit exceeded",
          span: at,
        }),
      ),
    );
  if (state.steps % 256 === 0) yield* perform(Effect.yieldNow());
}
function* allocate(state: State, units: number, at: Span): Evaluation<void, never, never> {
  const budget = Math.min(
    defaults.maxOutputBytes,
    state.config.memoryLimit ?? defaults.maxOutputBytes,
  );
  if (!Number.isFinite(units) || units < 0 || units > budget - state.allocationUnits)
    yield* perform(
      Effect.fail(
        new RenderError({
          code: "ResourceLimitExceeded",
          message: "Memory allocation limit exceeded",
          span: at,
        }),
      ),
    );
  state.allocationUnits += units;
}
function get(state: State, name: string): Value | undefined {
  for (let i = state.scopes.length - 1; i >= 0; i--) {
    const property = Object.getOwnPropertyDescriptor(state.scopes[i]!, name);
    if (property) return property.value as Value | undefined;
  }
  return undefined;
}
function enumerable(value: Value | undefined): readonly Value[] {
  if (isArray(value)) return value;
  if (typeof value === "string") return value ? [value] : [];
  if (value && typeof value === "object")
    return Object.entries(value).map(([key, item]) => [key, item]);
  return [];
}
function loopInfo(index: number, length: number, name?: string): Record<string, Value> {
  return {
    ...(name === undefined ? {} : { name }),
    index: index + 1,
    index0: index,
    rindex: length - index,
    rindex0: length - index - 1,
    first: index === 0,
    last: index === length - 1,
    length,
  };
}
function equal(a: Value | undefined, b: Value | undefined): boolean {
  if (a == null && b == null) return true;
  if (isArray(a) && isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  return a === b;
}
function* evaluateLenient<E, R>(
  expression: Expression,
  state: State,
  registry: Registry<E, R>,
): Evaluation<Value | undefined, E, R> {
  state.lenientDepth++;
  try {
    return yield* evaluate(expression, state, registry);
  } finally {
    state.lenientDepth--;
  }
}
function* evaluate<E, R>(
  expression: Expression,
  state: State,
  registry: Registry<E, R>,
): Evaluation<Value | undefined, E, R> {
  yield* tick(state, expression.span);
  switch (expression._tag) {
    case "Literal":
      return expression.value;
    case "Special":
      return null;
    case "Access": {
      let value = yield* evaluate(expression.receiver, state, registry);
      for (const segment of expression.segments)
        value = lookup(value, yield* evaluate(segment, state, registry));
      return value;
    }
    case "Lookup": {
      let value = get(state, expression.root);
      for (const segment of expression.segments)
        value = lookup(value, yield* evaluate(segment, state, registry));
      if (value === undefined && state.config.strictVariables && state.lenientDepth === 0)
        return yield* perform(
          Effect.fail(
            new RenderError({
              code: "MissingVariable",
              message: `Missing variable: ${expression.root}`,
              span: expression.span,
            }),
          ),
        );
      return value;
    }
    case "SelfLookup": {
      const [first, ...rest] = expression.segments;
      let value = get(state, stringify(yield* evaluate(first!, state, registry)));
      for (const segment of rest) value = lookup(value, yield* evaluate(segment, state, registry));
      if (value === undefined && state.config.strictVariables && state.lenientDepth === 0)
        return yield* perform(
          Effect.fail(
            new RenderError({
              code: "MissingVariable",
              message: "Missing variable: context lookup",
              span: expression.span,
            }),
          ),
        );
      return value;
    }
    case "Not":
      return !truthy(yield* evaluate(expression.value, state, registry));
    case "Range": {
      const from = Number(yield* evaluate(expression.from, state, registry));
      const to = Number(yield* evaluate(expression.to, state, registry));
      if (Number.isNaN(from) || Number.isNaN(to)) return [];
      const length = Math.max(0, Math.ceil(to + 1 - from));
      if (!Number.isFinite(length) || length > state.config.maxIterations)
        return yield* perform(
          Effect.fail(
            new RenderError({
              code: "ResourceLimitExceeded",
              message: "Range limit exceeded",
              span: expression.span,
            }),
          ),
        );
      yield* allocate(state, length, expression.span);
      return Array.from({ length }, (_, i) => from + i);
    }
    case "Binary": {
      const left = yield* evaluate(expression.left, state, registry);
      if (expression.operator === "and")
        return truthy(left) && truthy(yield* evaluate(expression.right, state, registry));
      if (expression.operator === "or")
        return truthy(left) || truthy(yield* evaluate(expression.right, state, registry));
      const right = yield* evaluate(expression.right, state, registry);
      const eq =
        expression.left._tag === "Special" && expression.right._tag === "Special"
          ? false
          : expression.right._tag === "Special"
            ? expression.right.value === "empty"
              ? empty(left)
              : blank(left)
            : expression.left._tag === "Special"
              ? expression.left.value === "empty"
                ? empty(right)
                : blank(right)
              : equal(left, right);
      switch (expression.operator) {
        case "==":
          return eq;
        case "!=":
          return !eq;
        case "contains":
          return typeof left === "string"
            ? left.includes(stringify(right))
            : isArray(left) && left.some((x) => equal(x, right));
        case ">":
          return left != null && right != null && left > right;
        case "<":
          return left != null && right != null && left < right;
        case ">=":
          return left != null && right != null && left >= right;
        case "<=":
          return left != null && right != null && left <= right;
        default:
          return false;
      }
    }
    case "Filter": {
      const rawInput = yield* state.config.lenientIf && expression.name === "default"
        ? evaluateLenient(expression.input, state, registry)
        : evaluate(expression.input, state, registry);
      const input = rawInput ?? null;
      const args: Value[] = [];
      const missingArguments: boolean[] = [];
      const specialArguments: ("empty" | "blank" | undefined)[] = [];
      for (const arg of expression.args) {
        const value = yield* evaluate(arg, state, registry);
        args.push(value ?? null);
        missingArguments.push(value === undefined);
        specialArguments.push(arg._tag === "Special" ? arg.value : undefined);
      }
      const named: Record<string, Value> = Object.create(null);
      for (const [key, arg] of Object.entries(expression.named))
        named[key] = (yield* evaluate(arg, state, registry)) ?? null;
      const filter = registry.filters.get(expression.name);
      if (
        ["json", "jsonify", "inspect"].includes(expression.name) &&
        rawInput === undefined &&
        filter === builtins.filters.get(expression.name)
      )
        return undefined;
      if (!filter) {
        if (!state.config.strictFilters) return input;
        return yield* perform(
          Effect.fail(
            new RenderError({
              code: "UnknownFilter",
              message: `Unknown filter: ${expression.name}`,
              span: expression.span,
            }),
          ),
        );
      }
      if ("expression" in filter) {
        if (state.filterDepth >= state.config.maxDepth)
          return yield* perform(
            Effect.fail(
              new RenderError({
                code: "ResourceLimitExceeded",
                message: "Expression filter nesting limit exceeded",
                span: expression.span,
              }),
            ),
          );
        const predicateText = stringify(args[1]);
        state.steps += predicateText.length;
        yield* tick(state, expression.span);
        const predicate = yield* perform(
          Effect.try({
            try: () =>
              embeddedExpression(
                predicateText,
                expression.args[1]?.span ?? expression.span,
                state.groupedExpressions,
              ),
            catch: (cause) => {
              if (cause instanceof ParseError)
                return new FilterFailure({
                  name: expression.name,
                  cause: new BuiltinFilterError({ message: cause.message }),
                  span: expression.span,
                });
              throw cause;
            },
          }),
        );
        const alias = stringify(args[0]);
        const values =
          filter.expression === "group_by"
            ? enumerable(input)
            : input === null
              ? []
              : isArray(input)
                ? input
                : [input];
        const result: Value[] = [];
        const groups = new Map<Value | undefined, Value[]>();
        state.filterDepth++;
        try {
          for (let index = 0; index < values.length; index++) {
            if (++state.iterations > state.config.maxIterations)
              return yield* perform(
                Effect.fail(
                  new RenderError({
                    code: "ResourceLimitExceeded",
                    message: "Iteration limit exceeded",
                    span: expression.span,
                  }),
                ),
              );
            state.scopes.push({ [alias]: values[index]! });
            let selected: Value | undefined;
            try {
              selected = yield* evaluate(predicate, state, registry);
            } finally {
              state.scopes.pop();
            }
            if (filter.expression === "group_by") {
              const bucket = groups.get(selected);
              if (bucket) bucket.push(values[index]!);
              else groups.set(selected, [values[index]!]);
            } else if (filter.expression === "where" || filter.expression === "reject") {
              if (selected === (filter.expression === "where")) result.push(values[index]!);
            } else if (selected) {
              return filter.expression === "has"
                ? true
                : filter.expression === "find_index"
                  ? index
                  : values[index];
            }
          }
          if (filter.expression === "group_by")
            return [...groups].map(([name, items]) => ({
              ...(name !== undefined ? { name } : {}),
              items,
            }));
          if (filter.expression === "where" || filter.expression === "reject") return result;
          return filter.expression === "has" ? false : undefined;
        } finally {
          state.filterDepth--;
        }
      }
      const callContext: FilterCallContext = {
        missingArguments,
        nilArguments: expression.args.map((arg) => arg._tag === "Literal" && arg.value === null),
        specialArguments,
        jekyllWhere: state.config.jekyllWhere,
        date: state.config,
        allocationLimit:
          Math.min(defaults.maxOutputBytes, state.config.memoryLimit ?? defaults.maxOutputBytes) -
          state.allocationUnits,
      };
      if (filter.allocation)
        yield* allocate(
          state,
          filter.allocation(input ?? null, args, callContext),
          expression.span,
        );
      const result = yield* perform(
        Effect.suspend(() =>
          filter
            .run(input, args, named, callContext)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new FilterFailure({ name: expression.name, cause, span: expression.span }),
              ),
            ),
        ),
      );
      return result === undefined ? undefined : yield* perform(normalize(result, expression.span));
    }
  }
}
// Count UTF-8 bytes without allocating an encoded copy. TextEncoder replaces
// unpaired surrogates with U+FFFD (three bytes); valid pairs occupy four bytes.
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
function* output(text: string, state: State, at: Span): Rendering<never, never> {
  state.outputBytes += utf8Length(text);
  if (state.outputBytes > state.config.maxOutputBytes)
    yield* perform(
      Effect.fail(
        new RenderError({
          code: "ResourceLimitExceeded",
          message: "Output limit exceeded",
          span: at,
        }),
      ),
    );
  yield text;
}
function* buffer<E, R>(iterator: Rendering<E, R>): Evaluation<string, E, R | TemplateLoader> {
  const chunks: string[] = [];
  let input: unknown;
  try {
    while (true) {
      const next = iterator.next(input);
      if (next.done) return chunks.join("");
      if (typeof next.value === "string") {
        chunks.push(next.value);
        input = undefined;
      } else input = yield* perform(next.value);
    }
  } finally {
    iterator.return();
  }
}
function* nodes<E, R>(
  body: readonly Node[],
  state: State,
  registry: Registry<E, R>,
  allowInterruptedFirst = false,
): Rendering<E, R> {
  for (let index = 0; index < body.length; index++) {
    if (state.control && !(allowInterruptedFirst && index === 0)) return;
    const node = body[index]!;
    yield* tick(state, node.span);
    const ev = (expression: Expression) => evaluate(expression, state, registry);
    const emit = (text: string) => output(text, state, node.span);
    switch (node._tag) {
      case "Text":
        yield* emit(node.value);
        break;
      case "Output": {
        const value = yield* ev(node.expression);
        if (
          !state.config.outputEscape ||
          (node.expression._tag === "Filter" && node.expression.name === "raw")
        ) {
          yield* emit(stringify(value));
          break;
        }
        const escaped =
          state.config.outputEscape === "json"
            ? (JSON.stringify(value) ?? "")
            : stringify(value).replace(
                /[&<>"']/g,
                (character) =>
                  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" })[
                    character
                  ]!,
              );
        yield* emit(escaped);
        break;
      }
      case "Counter": {
        const environment = state.scopes[1]!;
        const previous = Object.getOwnPropertyDescriptor(environment, node.name)?.value;
        const current = typeof previous === "number" ? previous : 0;
        environment[node.name] = current + node.direction;
        yield* emit(String(node.direction === 1 ? current : current - 1));
        break;
      }
      case "Cycle": {
        const group = node.group ? yield* ev(node.group) : undefined;
        const key = JSON.stringify([String(group), node.key]);
        const index = state.cycles.get(key) ?? 0;
        state.cycles.set(key, (index + 1) % node.values.length);
        const value = yield* ev(node.values[index]!);
        yield* emit(value ? stringify(value) : "");
        break;
      }
      case "Assign":
        state.scopes[2]![node.name] = yield* ev(node.expression);
        break;
      case "Capture":
        state.scopes[2]![node.name] = yield* buffer(nodes(node.body, state, registry));
        break;
      case "Break":
        state.control = "break";
        break;
      case "Continue":
        state.control = "continue";
        break;
      case "If": {
        let selected = node.otherwise;
        for (const branch of node.branches) {
          if (
            truthy(
              yield* state.config.lenientIf
                ? evaluateLenient(branch.condition, state, registry)
                : ev(branch.condition),
            )
          ) {
            selected = branch.body;
            break;
          }
        }
        yield* nodes(selected, state, registry);
        break;
      }
      case "Case": {
        const value = node.expression._tag === "Special" ? "" : yield* ev(node.expression);
        let branchHit = false;
        for (const branch of node.branches) {
          for (const test of branch.values) {
            const matched =
              test._tag === "Special"
                ? test.value === "blank"
                  ? blank(value)
                  : empty(value)
                : equal(value, yield* ev(test));
            if (matched) {
              branchHit = true;
              yield* nodes(branch.body, state, registry);
              break;
            }
          }
        }
        if (!branchHit) yield* nodes(node.otherwise, state, registry);
        break;
      }
      case "For":
      case "TableRow": {
        let values = enumerable(yield* ev(node.collection));
        if (node._tag === "For" && !values.length) {
          yield* nodes(node.otherwise, state, registry);
          break;
        }
        const offset =
          node._tag === "For" && node.offsetContinue
            ? (state.continuations.get(node.key) ?? 0)
            : node.offset
              ? Number(yield* ev(node.offset))
              : 0;
        const limit = node.limit ? Number(yield* ev(node.limit)) : values.length;
        if (node._tag === "For") {
          for (const modifier of node.modifiers ?? ["offset", "limit", "reversed"])
            if (modifier === "offset") values = values.slice(offset);
            else if (modifier === "limit") values = values.slice(0, limit);
            else if (node.reversed) values = [...values].reverse();
          state.continuations.set(node.key, offset + values.length);
        } else values = values.slice(offset, offset + limit);
        const cols =
          node._tag === "TableRow" && node.cols
            ? Number(
                node.cols._tag === "Literal" && node.cols.value === null
                  ? undefined
                  : (yield* ev(node.cols)) || values.length,
              )
            : values.length;
        for (let index = 0; index < values.length; index++) {
          if (++state.iterations > state.config.maxIterations)
            yield* perform(
              Effect.fail(
                new RenderError({
                  code: "ResourceLimitExceeded",
                  message: "Iteration limit exceeded",
                  span: node.span,
                }),
              ),
            );
          // Empty bodies still need an interruption boundary during large loops.
          if (state.iterations % 256 === 0) yield* perform(Effect.yieldNow());
          state.scopes.push({
            [node.name]: values[index]!,
            [node._tag === "TableRow" ? "tablerowloop" : "forloop"]: {
              ...loopInfo(index, values.length, node.loopName),
              ...(node._tag === "TableRow"
                ? {
                    row: Math.floor(index / cols) + 1,
                    col: (index % cols) + 1,
                    col0: index % cols,
                    col_first: index % cols === 0,
                    col_last: (index % cols) + 1 === cols,
                  }
                : {}),
            },
          });
          let stopped = false;
          try {
            if (node._tag === "TableRow")
              yield* emit(
                (index % cols === 0 ? `<tr class="row${Math.floor(index / cols) + 1}">` : "") +
                  `<td class="col${(index % cols) + 1}">`,
              );
            yield* nodes(node.body, state, registry, node._tag === "TableRow");
            if (node._tag === "TableRow")
              yield* emit(
                `</td>${(index + 1) % cols === 0 || index === values.length - 1 ? "</tr>" : ""}`,
              );
          } finally {
            state.scopes.pop();
            if (node._tag === "For") {
              stopped = state.control === "break";
              state.control = undefined;
            }
          }
          if (stopped) break;
        }
        break;
      }
      case "Block": {
        if (state.layoutStore) {
          state.layoutBlocks.set(node.name, node.body);
          break;
        }
        const override = state.layoutBlocks.get(node.name);
        if (!override) {
          yield* nodes(node.body, state, registry);
          break;
        }
        const parent = yield* buffer(nodes(node.body, state, registry));
        state.scopes.push({ block: { super: parent } });
        try {
          yield* nodes(override, state, registry);
        } finally {
          state.scopes.pop();
        }
        break;
      }
      case "Layout": {
        if (!node.template) {
          yield* nodes(node.body, state, registry);
          break;
        }
        if (state.depth >= state.config.maxDepth)
          yield* perform(
            Effect.fail(
              new RenderError({
                code: "ResourceLimitExceeded",
                message: "Template recursion limit exceeded",
                span: node.span,
              }),
            ),
          );
        const name = stringify(yield* ev(node.template));
        const previousStore = state.layoutStore;
        const previousBlocks = state.layoutBlocks;
        state.layoutStore = true;
        state.layoutBlocks = new Map();
        try {
          let html: string;
          try {
            html = yield* buffer(nodes(node.body, state, registry));
          } finally {
            state.layoutStore = previousStore;
          }
          const blocks = state.layoutBlocks;
          if (!blocks.has("")) blocks.set("", [{ _tag: "Text", value: html, span: node.span }]);
          for (const [key, value] of previousBlocks) blocks.set(key, value);
          const args: Record<string, Value> = Object.create(null);
          for (const [key, value] of Object.entries(node.args))
            args[key] = (yield* ev(value)) ?? null;
          const loader = yield* perform(TemplateLoader);
          const source = yield* perform(
            Effect.suspend(() => loader.load(name, node.span.sourceId, "layout")),
          );
          const document = yield* perform(
            parse(source, {
              ...state.whitespace,
              ...state.delimiters,
              dialect: state.dialect,
              groupedExpressions: state.groupedExpressions,
              orderedFilterParameters: state.orderedFilterParameters,
            }),
          );
          state.scopes.push(args);
          state.depth++;
          try {
            yield* nodes(document.body, state, registry);
          } finally {
            state.scopes.pop();
            state.depth--;
          }
        } finally {
          state.layoutStore = previousStore;
          state.layoutBlocks = previousBlocks;
        }
        break;
      }
      case "Partial": {
        if (state.depth >= state.config.maxDepth)
          yield* perform(
            Effect.fail(
              new RenderError({
                code: "ResourceLimitExceeded",
                message: "Template recursion limit exceeded",
                span: node.span,
              }),
            ),
          );
        let name = stringify(yield* ev(node.template));
        const interpolation = state.delimiters.outputDelimiterLeft ?? "{{";
        if (
          node.template._tag === "Literal" &&
          typeof node.template.value === "string" &&
          name.includes(interpolation)
        ) {
          const nameDocument = yield* perform(
            parse(name, {
              ...state.whitespace,
              ...state.delimiters,
              dialect: state.dialect,
              groupedExpressions: state.groupedExpressions,
              orderedFilterParameters: state.orderedFilterParameters,
            }),
          );
          name = yield* buffer(nodes(nameDocument.body, state, registry));
        }
        const args: Record<string, Value> = Object.create(null);
        for (const [key, value] of Object.entries(node.args))
          args[key] = (yield* ev(value)) ?? null;
        if (node.with) args[node.with.alias ?? name] = (yield* ev(node.with.value)) ?? null;
        const collection = node.for ? yield* ev(node.for.value) : null;
        const items = node.for
          ? node.mode === "include" && collection != null && !isArray(collection)
            ? [collection]
            : enumerable(collection)
          : [null];
        if (!items.length) break;
        const loader = yield* perform(TemplateLoader);
        const source = yield* perform(
          Effect.suspend(() => loader.load(name, node.span.sourceId, node.mode)),
        );
        const document = yield* perform(
          parse(source, {
            ...state.whitespace,
            ...state.delimiters,
            dialect: state.dialect,
            groupedExpressions: state.groupedExpressions,
            orderedFilterParameters: state.orderedFilterParameters,
          }),
        );
        const old = state.scopes;
        const oldCycles = state.cycles;
        const oldContinuations = state.continuations;
        const oldControl = state.control;
        state.scopes =
          node.mode === "render" ? [old[0]!, Object.create(null), args] : [...old, args];
        if (node.mode === "render") {
          state.cycles = new Map();
          state.continuations = new Map();
        }
        state.depth++;
        try {
          for (let index = 0; index < items.length; index++) {
            if (node.for) {
              if (++state.iterations > state.config.maxIterations)
                yield* perform(
                  Effect.fail(
                    new RenderError({
                      code: "ResourceLimitExceeded",
                      message: "Iteration limit exceeded",
                      span: node.span,
                    }),
                  ),
                );
              if (state.iterations % 256 === 0) yield* perform(Effect.yieldNow());
              // The pinned oracle binds an omitted for-alias to the literal key "undefined".
              args[node.for.alias ?? (node.mode === "include" ? name : "undefined")] =
                items[index]!;
              if (node.mode === "render") args.forloop = loopInfo(index, items.length);
            }
            yield* nodes(document.body, state, registry);
            if (state.control) break;
          }
        } finally {
          state.scopes = old;
          state.cycles = oldCycles;
          state.continuations = oldContinuations;
          if (node.mode === "render") state.control = oldControl;
          state.depth--;
        }
        break;
      }
    }
  }
}
function initialize(document: Document, context: unknown) {
  return Effect.gen(function* () {
    const supplied = yield* RenderConfig;
    const config = {
      ...supplied,
      maxSteps: Math.min(
        supplied.maxSteps,
        supplied.renderLimit === undefined
          ? supplied.maxSteps
          : Math.max(1, Math.ceil(supplied.renderLimit * 1000)),
      ),
    };
    const at = { sourceId: document.source.id, start: 0, end: document.source.text.length };
    for (const key of Object.keys(config))
      if (!Object.hasOwn(defaults, key))
        return yield* Effect.fail(
          new RenderError({
            code: "InvalidOperation",
            message: `Unsupported render option: ${key}`,
            span: at,
          }),
        );
    for (const key of ["maxSteps", "maxIterations", "maxOutputBytes", "maxDepth"] as const) {
      if (!Number.isSafeInteger(config[key]) || config[key] < 1)
        return yield* Effect.fail(
          new RenderError({
            code: "InvalidOperation",
            message: `Invalid limit: ${key}`,
            span: at,
          }),
        );
    }
    for (const key of ["memoryLimit", "renderLimit"] as const)
      if (config[key] !== undefined && (!Number.isFinite(config[key]) || config[key]! < 0))
        return yield* Effect.fail(
          new RenderError({ code: "InvalidOperation", message: `Invalid limit: ${key}`, span: at }),
        );
    if (
      typeof config.preserveTimezones !== "boolean" ||
      typeof config.locale !== "string" ||
      typeof config.dateFormat !== "string" ||
      (config.timezoneOffset !== undefined &&
        typeof config.timezoneOffset !== "string" &&
        (typeof config.timezoneOffset !== "number" || !Number.isFinite(config.timezoneOffset)))
    )
      return yield* Effect.fail(
        new RenderError({ code: "InvalidOperation", message: "Invalid date options", span: at }),
      );
    const value = yield* normalize(context, at);
    const globals = yield* normalize(config.globals, at);
    if (
      !value ||
      typeof value !== "object" ||
      isArray(value) ||
      !globals ||
      typeof globals !== "object" ||
      isArray(globals)
    )
      return yield* Effect.fail(
        new RenderError({
          code: "InvalidContext",
          message: "Root context and globals must be records",
          span: at,
        }),
      );
    const state: State = {
      scopes: [
        globals as Record<string, Value>,
        value as Record<string, Value>,
        Object.create(null),
      ],
      cycles: new Map(),
      continuations: new Map(),
      steps: 0,
      iterations: 0,
      outputBytes: 0,
      allocationUnits: 0,
      control: undefined,
      depth: 0,
      filterDepth: 0,
      lenientDepth: 0,
      layoutStore: false,
      layoutBlocks: new Map(),
      dialect: document.dialect ?? "liquidjs",
      groupedExpressions: document.groupedExpressions ?? false,
      orderedFilterParameters: document.orderedFilterParameters ?? false,
      whitespace: {
        ...document.whitespace,
        ...(document.parseLimit === undefined ? {} : { parseLimit: document.parseLimit }),
      },
      delimiters: document.delimiters ?? {},
      config,
    };
    return state;
  });
}
export function renderStream(
  document: Document,
  context?: unknown,
): Stream.Stream<string, Failure<never>, RenderConfig | TemplateLoader>;
export function renderStream<E, R>(
  document: Document,
  context: unknown,
  registry: Registry<E, R>,
): Stream.Stream<string, Failure<E>, R | RenderConfig | TemplateLoader>;
export function renderStream<E = never, R = never>(
  document: Document,
  context: unknown = {},
  registry: Registry<E | BuiltinFilterError, R> = builtins,
): Stream.Stream<string, Failure<E>, R | RenderConfig | TemplateLoader> {
  return Stream.unwrapScoped(
    Effect.gen(function* () {
      const state = yield* initialize(document, context);
      const iterator = nodes(document.body, state, registry);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          iterator.return();
        }),
      );
      let pending:
        | IteratorResult<string | Effect.Effect<unknown, Failure<E>, R | TemplateLoader>, void>
        | undefined;
      const pull = Effect.gen(function* () {
        const chunks: string[] = [];
        let characters = 0;
        while (true) {
          const next = pending ?? iterator.next();
          pending = undefined;
          if (next.done) {
            if (chunks.length) return Chunk.fromIterable(chunks);
            return yield* Effect.fail(Option.none<Failure<E>>());
          }
          if (typeof next.value === "string") {
            chunks.push(next.value);
            characters += next.value.length;
            // Bound both tiny outputs and large pure runs. No producer fiber or queue.
            if (chunks.length >= 128 || characters >= 16_384) return Chunk.fromIterable(chunks);
          } else {
            // Emit prior output before executing effects (including failures), so
            // taking a prefix never starts a later filter or template load.
            if (chunks.length) {
              pending = next;
              return Chunk.fromIterable(chunks);
            }
            const value = yield* next.value.pipe(Effect.mapError(Option.some));
            pending = iterator.next(value);
          }
        }
      });
      return Stream.repeatEffectChunkOption(pull);
    }),
  );
}

export function render(
  document: Document,
  context?: unknown,
): Effect.Effect<string, Failure<never>, RenderConfig | TemplateLoader>;
export function render<E, R>(
  document: Document,
  context: unknown,
  registry: Registry<E, R>,
): Effect.Effect<string, Failure<E>, R | RenderConfig | TemplateLoader>;
export function render<E = never, R = never>(
  document: Document,
  context: unknown = {},
  registry: Registry<E | BuiltinFilterError, R> = builtins,
) {
  return Effect.gen(function* () {
    const state = yield* initialize(document, context);
    const iterator = buffer(nodes(document.body, state, registry));
    return yield* Effect.gen(function* () {
      let input: unknown;
      while (true) {
        const next = iterator.next(input);
        if (next.done) return next.value;
        input = yield* next.value;
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          iterator.return("");
        }),
      ),
    );
  }).pipe(Effect.withSpan("liquid.render"));
}
