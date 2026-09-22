import { Context, Effect, Layer, Stream } from "effect";
import type { Document, Expression, Node } from "./Ast.js";
import { registry as builtins } from "./Builtins.js";
import {
  BuiltinFilterError,
  FilterFailure,
  type LoadError,
  ParseError,
  RenderError,
} from "./Diagnostic.js";
import { embeddedExpression } from "./EmbeddedExpression.js";
import type { Registry } from "./Filter.js";
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
export interface Config {
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
  whitespace: WhitespaceOptions;
  delimiters: DelimiterOptions;
  groupedExpressions: boolean;
  scopes: Record<string, Value>[];
  cycles: Map<string, number>;
  continuations: Map<string, number>;
  steps: number;
  iterations: number;
  outputBytes: number;
  control: "break" | "continue" | undefined;
  depth: number;
  filterDepth: number;
  lenientDepth: number;
  layoutStore: boolean;
  layoutBlocks: Map<string, readonly Node[]>;
  config: Config;
}
type Failure<E> = RenderError | ParseError | LoadError | FilterFailure<E | BuiltinFilterError>;
function tick(state: State, at: Span): Effect.Effect<void, RenderError> {
  if (++state.steps > state.config.maxSteps)
    return Effect.fail(
      new RenderError({ code: "ResourceLimitExceeded", message: "Work limit exceeded", span: at }),
    );
  return state.steps % 256 === 0 ? Effect.yieldNow() : Effect.void;
}
function get(state: State, name: string): Value | undefined {
  for (let i = state.scopes.length - 1; i >= 0; i--) {
    const value = Object.getOwnPropertyDescriptor(state.scopes[i]!, name)?.value as
      | Value
      | undefined;
    if (value !== undefined) return value;
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
function loopInfo(index: number, length: number): Record<string, Value> {
  return {
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
function evaluateLenient<E, R>(
  expression: Expression,
  state: State,
  registry: Registry<E, R>,
): Effect.Effect<Value | undefined, RenderError | FilterFailure<E | BuiltinFilterError>, R> {
  return Effect.gen(function* () {
    state.lenientDepth++;
    return yield* evaluate(expression, state, registry).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          state.lenientDepth--;
        }),
      ),
    );
  });
}
function evaluate<E, R>(
  expression: Expression,
  state: State,
  registry: Registry<E, R>,
): Effect.Effect<Value | undefined, RenderError | FilterFailure<E | BuiltinFilterError>, R> {
  return Effect.gen(function* () {
    yield* tick(state, expression.span);
    switch (expression._tag) {
      case "Literal":
        return expression.value;
      case "Special":
        return null;
      case "Lookup": {
        let value = get(state, expression.root);
        for (const segment of expression.segments)
          value = lookup(value, yield* evaluate(segment, state, registry));
        if (value === undefined && state.config.strictVariables && state.lenientDepth === 0)
          return yield* Effect.fail(
            new RenderError({
              code: "MissingVariable",
              message: `Missing variable: ${expression.root}`,
              span: expression.span,
            }),
          );
        return value;
      }
      case "Not":
        return !truthy(yield* evaluate(expression.value, state, registry));
      case "Range": {
        const from = Number(yield* evaluate(expression.from, state, registry));
        const to = Number(yield* evaluate(expression.to, state, registry));
        const length = Math.max(0, Math.floor(to) - Math.floor(from) + 1);
        if (!Number.isFinite(length) || length > state.config.maxIterations)
          return yield* Effect.fail(
            new RenderError({
              code: "ResourceLimitExceeded",
              message: "Range limit exceeded",
              span: expression.span,
            }),
          );
        return Array.from({ length }, (_, i) => Math.floor(from) + i);
      }
      case "Binary": {
        const left = yield* evaluate(expression.left, state, registry);
        if (expression.operator === "and")
          return truthy(left) && truthy(yield* evaluate(expression.right, state, registry));
        if (expression.operator === "or")
          return truthy(left) || truthy(yield* evaluate(expression.right, state, registry));
        const right = yield* evaluate(expression.right, state, registry);
        const eq =
          expression.right._tag === "Special"
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
          expression.name === "json" &&
          rawInput === undefined &&
          filter === builtins.filters.get("json")
        )
          return undefined;
        if (!filter) {
          if (!state.config.strictFilters) return input;
          return yield* Effect.fail(
            new RenderError({
              code: "UnknownFilter",
              message: `Unknown filter: ${expression.name}`,
              span: expression.span,
            }),
          );
        }
        if ("expression" in filter) {
          if (state.filterDepth >= state.config.maxDepth)
            return yield* Effect.fail(
              new RenderError({
                code: "ResourceLimitExceeded",
                message: "Expression filter nesting limit exceeded",
                span: expression.span,
              }),
            );
          const predicateText = stringify(args[1]);
          state.steps += predicateText.length;
          yield* tick(state, expression.span);
          const predicate = yield* Effect.try({
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
          });
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
          return yield* Effect.gen(function* () {
            for (let index = 0; index < values.length; index++) {
              if (++state.iterations > state.config.maxIterations)
                return yield* Effect.fail(
                  new RenderError({
                    code: "ResourceLimitExceeded",
                    message: "Iteration limit exceeded",
                    span: expression.span,
                  }),
                );
              state.scopes.push({ [alias]: values[index]! });
              const selected = yield* evaluate(predicate, state, registry).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    state.scopes.pop();
                  }),
                ),
              );
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
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                state.filterDepth--;
              }),
            ),
          );
        }
        const result = yield* filter
          .run(input, args, named, {
            missingArguments,
            specialArguments,
            jekyllWhere: state.config.jekyllWhere,
          })
          .pipe(
            Effect.mapError(
              (cause) => new FilterFailure({ name: expression.name, cause, span: expression.span }),
            ),
          );
        return result === undefined ? undefined : yield* normalize(result, expression.span);
      }
    }
  });
}
function nodes<E, R>(
  body: readonly Node[],
  state: State,
  registry: Registry<E, R>,
): Stream.Stream<string, Failure<E>, R | TemplateLoader> {
  return Stream.fromIterable(body).pipe(
    Stream.flatMap((node) =>
      Stream.suspend(() =>
        state.control
          ? Stream.empty
          : Stream.unwrap(
              Effect.gen(function* () {
                yield* tick(state, node.span);
                const ev = (e: Expression) => evaluate(e, state, registry);
                const output = (text: string) =>
                  Stream.fromEffect(
                    Effect.gen(function* () {
                      state.outputBytes += new TextEncoder().encode(text).length;
                      if (state.outputBytes > state.config.maxOutputBytes)
                        return yield* Effect.fail(
                          new RenderError({
                            code: "ResourceLimitExceeded",
                            message: "Output limit exceeded",
                            span: node.span,
                          }),
                        );
                      return text;
                    }),
                  );
                switch (node._tag) {
                  case "Text":
                    return output(node.value);
                  case "Output": {
                    const value = yield* ev(node.expression);
                    if (
                      !state.config.outputEscape ||
                      (node.expression._tag === "Filter" && node.expression.name === "raw")
                    )
                      return output(stringify(value));
                    const escaped =
                      state.config.outputEscape === "json"
                        ? (JSON.stringify(value) ?? "")
                        : stringify(value).replace(
                            /[&<>"']/g,
                            (character) =>
                              ({
                                "&": "&amp;",
                                "<": "&lt;",
                                ">": "&gt;",
                                '"': "&#34;",
                                "'": "&#39;",
                              })[character]!,
                          );
                    return output(escaped);
                  }
                  case "Counter": {
                    const environment = state.scopes[1]!;
                    const previous = Object.getOwnPropertyDescriptor(environment, node.name)?.value;
                    const current = typeof previous === "number" ? previous : 0;
                    environment[node.name] = current + node.direction;
                    return output(String(node.direction === 1 ? current : current - 1));
                  }
                  case "Cycle": {
                    const group = node.group ? yield* ev(node.group) : undefined;
                    const key = JSON.stringify([String(group), node.key]);
                    const index = state.cycles.get(key) ?? 0;
                    state.cycles.set(key, (index + 1) % node.values.length);
                    return output(stringify(yield* ev(node.values[index]!)));
                  }
                  case "Assign":
                    state.scopes[2]![node.name] = (yield* ev(node.expression)) ?? null;
                    return Stream.empty;
                  case "Capture": {
                    const value = yield* Stream.runFold(
                      nodes(node.body, state, registry),
                      "",
                      (a, b) => a + b,
                    );
                    state.scopes[2]![node.name] = value;
                    return Stream.empty;
                  }
                  case "Break":
                    state.control = "break";
                    return Stream.empty;
                  case "Continue":
                    state.control = "continue";
                    return Stream.empty;
                  case "If": {
                    for (const branch of node.branches)
                      if (
                        truthy(
                          yield* state.config.lenientIf
                            ? evaluateLenient(branch.condition, state, registry)
                            : ev(branch.condition),
                        )
                      )
                        return nodes(branch.body, state, registry);
                    return nodes(node.otherwise, state, registry);
                  }
                  case "Case": {
                    const value = yield* ev(node.expression);
                    for (const branch of node.branches)
                      for (const test of branch.values)
                        if (equal(value, yield* ev(test)))
                          return nodes(branch.body, state, registry);
                    return nodes(node.otherwise, state, registry);
                  }
                  case "For":
                  case "TableRow": {
                    const collection = yield* ev(node.collection);
                    let values = enumerable(collection);
                    if (node._tag === "For" && !values.length)
                      return nodes(node.otherwise, state, registry);
                    const offset =
                      node._tag === "For" && node.offsetContinue
                        ? (state.continuations.get(node.key) ?? 0)
                        : node.offset
                          ? Number(yield* ev(node.offset))
                          : 0;
                    const limit = node.limit ? Number(yield* ev(node.limit)) : values.length;
                    values =
                      node._tag === "For"
                        ? values.slice(offset).slice(0, limit)
                        : values.slice(offset, offset + limit);
                    if (node._tag === "For")
                      state.continuations.set(node.key, offset + values.length);
                    if (node._tag === "For" && node.reversed) values = [...values].reverse();
                    const cols =
                      node._tag === "TableRow" && node.cols
                        ? Number(stringify(yield* ev(node.cols))) || values.length
                        : values.length;
                    if (!values.length) return Stream.empty;
                    let stopped = false;
                    return Stream.fromIterable(
                      values.map((value, index) => ({ value, index })),
                    ).pipe(
                      Stream.flatMap(({ value, index }) =>
                        Stream.suspend(() => {
                          if (stopped) return Stream.empty;
                          if (++state.iterations > state.config.maxIterations)
                            return Stream.fail(
                              new RenderError({
                                code: "ResourceLimitExceeded",
                                message: "Iteration limit exceeded",
                                span: node.span,
                              }),
                            );
                          state.scopes.push({
                            [node.name]: value,
                            [node._tag === "TableRow" ? "tablerowloop" : "forloop"]: {
                              ...loopInfo(index, values.length),
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
                          let content = nodes(node.body, state, registry);
                          if (node._tag === "TableRow") {
                            const prefix =
                              (index % cols === 0
                                ? `<tr class="row${Math.floor(index / cols) + 1}">`
                                : "") + `<td class="col${(index % cols) + 1}">`;
                            const suffix =
                              "</td>" +
                              ((index + 1) % cols === 0 || index === values.length - 1
                                ? "</tr>"
                                : "");
                            content = Stream.concat(
                              Stream.concat(output(prefix), content),
                              output(suffix),
                            );
                          }
                          return content.pipe(
                            Stream.ensuring(
                              Effect.sync(() => {
                                state.scopes.pop();
                                if (state.control === "break") stopped = true;
                                state.control = undefined;
                              }),
                            ),
                          );
                        }),
                      ),
                    );
                  }
                  case "Block": {
                    if (state.layoutStore) {
                      state.layoutBlocks.set(node.name, node.body);
                      return Stream.empty;
                    }
                    const override = state.layoutBlocks.get(node.name);
                    if (!override) return nodes(node.body, state, registry);
                    const parent = Array.from(
                      yield* Stream.runCollect(nodes(node.body, state, registry)),
                    ).join("");
                    state.scopes.push({ block: { super: parent } });
                    return nodes(override, state, registry).pipe(
                      Stream.ensuring(
                        Effect.sync(() => {
                          state.scopes.pop();
                        }),
                      ),
                    );
                  }
                  case "Layout": {
                    if (!node.template) return nodes(node.body, state, registry);
                    if (state.depth >= state.config.maxDepth)
                      return Stream.fail(
                        new RenderError({
                          code: "ResourceLimitExceeded",
                          message: "Template recursion limit exceeded",
                          span: node.span,
                        }),
                      );
                    const name = stringify(yield* ev(node.template));
                    const previousStore = state.layoutStore;
                    const previousBlocks = state.layoutBlocks;
                    state.layoutStore = true;
                    state.layoutBlocks = new Map();
                    const html = yield* Stream.runCollect(nodes(node.body, state, registry)).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          state.layoutStore = previousStore;
                        }),
                      ),
                    );
                    const blocks = state.layoutBlocks;
                    if (!blocks.has(""))
                      blocks.set("", [
                        { _tag: "Text", value: Array.from(html).join(""), span: node.span },
                      ]);
                    for (const [key, value] of previousBlocks) blocks.set(key, value);
                    state.layoutBlocks = blocks;
                    const args: Record<string, Value> = Object.create(null);
                    for (const [key, value] of Object.entries(node.args))
                      args[key] = (yield* ev(value)) ?? null;
                    const loader = yield* TemplateLoader;
                    const source = yield* loader.load(name, node.span.sourceId, "layout");
                    const document = yield* parse(source, {
                      ...state.whitespace,
                      ...state.delimiters,
                      groupedExpressions: state.groupedExpressions,
                    });
                    state.scopes.push(args);
                    state.depth++;
                    return nodes(document.body, state, registry).pipe(
                      Stream.ensuring(
                        Effect.sync(() => {
                          state.scopes.pop();
                          state.depth--;
                          state.layoutStore = previousStore;
                          state.layoutBlocks = previousBlocks;
                        }),
                      ),
                    );
                  }
                  case "Partial": {
                    if (state.depth >= state.config.maxDepth)
                      return Stream.fail(
                        new RenderError({
                          code: "ResourceLimitExceeded",
                          message: "Template recursion limit exceeded",
                          span: node.span,
                        }),
                      );
                    let name = stringify(yield* ev(node.template));
                    const interpolation = state.delimiters.outputDelimiterLeft ?? "{{";
                    if (
                      node.template._tag === "Literal" &&
                      typeof node.template.value === "string" &&
                      name.includes(interpolation)
                    ) {
                      const nameDocument = yield* parse(name, {
                        ...state.whitespace,
                        ...state.delimiters,
                        groupedExpressions: state.groupedExpressions,
                      });
                      const chunks = yield* Stream.runCollect(
                        nodes(nameDocument.body, state, registry),
                      );
                      name = Array.from(chunks).join("");
                    }
                    const args: Record<string, Value> = Object.create(null);
                    for (const [key, value] of Object.entries(node.args))
                      args[key] = (yield* ev(value)) ?? null;
                    if (node.with)
                      args[node.with.alias ?? name] = (yield* ev(node.with.value)) ?? null;
                    const items = node.for ? enumerable(yield* ev(node.for.value)) : [null];
                    if (!items.length) return Stream.empty;
                    const loader = yield* TemplateLoader;
                    const source = yield* loader.load(name, node.span.sourceId, node.mode);
                    const document = yield* parse(source, {
                      ...state.whitespace,
                      ...state.delimiters,
                      groupedExpressions: state.groupedExpressions,
                    });
                    const old = state.scopes;
                    const oldCycles = state.cycles;
                    const oldContinuations = state.continuations;
                    state.scopes =
                      node.mode === "render"
                        ? [old[0]!, Object.create(null), args]
                        : [...old, args];
                    if (node.mode === "render") {
                      state.cycles = new Map();
                      state.continuations = new Map();
                    }
                    state.depth++;
                    return Stream.fromIterable(
                      items.map((value, index) => ({ value, index })),
                    ).pipe(
                      Stream.flatMap(({ value, index }) =>
                        Stream.suspend(() => {
                          if (node.for) {
                            if (++state.iterations > state.config.maxIterations)
                              return Stream.fail(
                                new RenderError({
                                  code: "ResourceLimitExceeded",
                                  message: "Iteration limit exceeded",
                                  span: node.span,
                                }),
                              );
                            // The pinned oracle binds an omitted for-alias to the literal key "undefined".
                            const alias = node.for.alias ?? "undefined";
                            args[alias] = value;
                            args.forloop = loopInfo(index, items.length);
                          }
                          return nodes(document.body, state, registry);
                        }),
                      ),
                      Stream.ensuring(
                        Effect.sync(() => {
                          state.scopes = old;
                          state.cycles = oldCycles;
                          state.continuations = oldContinuations;
                          state.depth--;
                        }),
                      ),
                    );
                  }
                }
              }),
            ),
      ),
    ),
  );
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
  return Stream.unwrap(
    Effect.gen(function* () {
      const config = yield* RenderConfig;
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
        control: undefined,
        depth: 0,
        filterDepth: 0,
        lenientDepth: 0,
        layoutStore: false,
        layoutBlocks: new Map(),
        groupedExpressions: document.groupedExpressions ?? false,
        whitespace: document.whitespace ?? {},
        delimiters: document.delimiters ?? {},
        config,
      };
      return nodes(document.body, state, registry);
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
  return Stream.runFold(renderStream(document, context, registry), "", (a, b) => a + b).pipe(
    Effect.withSpan("liquid.render"),
  );
}
