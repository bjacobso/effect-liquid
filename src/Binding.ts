/** Shared environment boundaries: assignments target the template frame; loop names shadow it. */
export interface Flow<T> {
  readonly values: Map<string, T>;
  readonly locals: Map<string, T>;
}
export const make = <T>(): Flow<T> => ({ values: new Map(), locals: new Map() });
export const fork = <T>(flow: Flow<T>): Flow<T> => ({
  values: new Map(flow.values),
  locals: new Map(flow.locals),
});
export const read = <T>(flow: Flow<T>, name: string): T | undefined =>
  flow.locals.get(name) ?? flow.values.get(name);
export function join<T>(
  target: Flow<T>,
  branches: readonly Flow<T>[],
  merge: (values: readonly (T | undefined)[], name: string) => T,
): void {
  const names = new Set(branches.flatMap((b) => [...b.values.keys()]));
  for (const name of names) {
    const value = merge(
      branches.map((b) => b.values.get(name)),
      name,
    );
    if (value !== target.values.get(name)) {
      for (const key of target.locals.keys())
        if (key === `@${name}` || key.startsWith(`@${name}.`) || key.startsWith(`@${name}[`))
          target.locals.delete(key);
    }
    target.values.set(name, value);
  }
}

/** Normal and abrupt successors stay separate until the owning loop consumes them. */
export interface Completion<T> {
  readonly normal: Flow<T> | undefined;
  readonly breaks: readonly Flow<T>[];
  readonly continues: readonly Flow<T>[];
}
export const completion = <T>(normal: Flow<T> | undefined): Completion<T> => ({
  normal,
  breaks: [],
  continues: [],
});
export function successors<T>(result: Completion<T>): readonly Flow<T>[] {
  return [...(result.normal ? [result.normal] : []), ...result.continues];
}
/** A loop header includes the first iteration and every reachable back edge. */
export function fixedPoint<T>(
  initial: Flow<T>,
  transfer: (header: Flow<T>) => Completion<T>,
  merge: (values: readonly (T | undefined)[], name: string) => T,
  equal: (left: T | undefined, right: T | undefined) => boolean,
  widen: (value: T, name: string) => T,
  limit = 16,
): { readonly exits: readonly Flow<T>[]; readonly converged: boolean } {
  let header = fork(initial);
  for (let iteration = 0; iteration <= limit; iteration++) {
    const result = transfer(fork(header));
    const next = fork(initial);
    join(next, [initial, ...successors(result)], (values, name) => merge(values, name));
    const names = new Set([...header.values.keys(), ...next.values.keys()]);
    if ([...names].every((name) => equal(header.values.get(name), next.values.get(name))))
      return {
        exits: [...(result.normal ? [result.normal] : []), ...result.breaks, ...result.continues],
        converged: true,
      };
    if (iteration === limit) {
      for (const name of names) next.values.set(name, widen(next.values.get(name)!, name));
      const widened = transfer(next);
      return {
        exits: [
          ...(widened.normal ? [widened.normal] : []),
          ...widened.breaks,
          ...widened.continues,
        ],
        converged: false,
      };
    }
    header = next;
  }
  throw new Error("Unreachable loop solver state");
}

/** Every built-in declares its traversed children and scope/control obligations. */
export interface TagMetadata {
  readonly expressions: readonly string[];
  readonly bodies: readonly string[];
  readonly scope: "shared" | "shadow" | "isolated-or-shared";
  readonly control: "normal" | "branches" | "loop" | "break" | "continue";
  readonly builtin?: string;
}
const shared: TagMetadata = { expressions: [], bodies: [], scope: "shared", control: "normal" };
export const tagMetadata: Readonly<Record<import("./Ast.js").Node["_tag"], TagMetadata>> = {
  Text: shared,
  IfChanged: { ...shared, bodies: ["body"] },
  Output: { ...shared, expressions: ["expression"] },
  Assign: { ...shared, expressions: ["expression"] },
  Counter: shared,
  Cycle: { ...shared, expressions: ["group", "values"] },
  Capture: { ...shared, bodies: ["body"] },
  If: {
    ...shared,
    expressions: ["branches.condition"],
    bodies: ["branches.body", "otherwise"],
    control: "branches",
  },
  Case: {
    ...shared,
    expressions: ["expression", "branches.values"],
    bodies: ["branches.body", "otherwise"],
    control: "branches",
  },
  For: {
    expressions: ["collection", "limit", "offset"],
    bodies: ["body", "otherwise"],
    scope: "shadow",
    control: "loop",
    builtin: "forloop",
  },
  TableRow: {
    expressions: ["collection", "limit", "offset", "cols"],
    bodies: ["body"],
    scope: "shadow",
    control: "loop",
    builtin: "tablerowloop",
  },
  Break: { ...shared, control: "break" },
  Continue: { ...shared, control: "continue" },
  Block: { ...shared, bodies: ["body"], scope: "shadow", builtin: "block" },
  Layout: { ...shared, expressions: ["template", "args"], bodies: ["body"] },
  Partial: {
    ...shared,
    expressions: ["template", "args", "with.value", "for.value"],
    scope: "isolated-or-shared",
  },
};

/** Known empty/single collections avoid speculative back edges and impossible else paths. */
export function loopShape(node: Extract<import("./Ast.js").Node, { _tag: "For" | "TableRow" }>): {
  readonly body: boolean;
  readonly empty: boolean;
  readonly repeat: boolean;
} {
  const collection = node.collection;
  let length: number | undefined;
  if (collection._tag === "Literal")
    length = typeof collection.value === "string" && collection.value ? 1 : 0;
  else if (
    collection._tag === "Range" &&
    collection.from._tag === "Literal" &&
    collection.to._tag === "Literal"
  ) {
    const from = Number(collection.from.value),
      to = Number(collection.to.value);
    length = Number.isNaN(from) || Number.isNaN(to) ? 0 : Math.max(0, Math.ceil(to + 1 - from));
  }
  const empty = length === undefined || length === 0;
  if (length !== undefined) {
    for (const modifier of node._tag === "For"
      ? (node.modifiers ?? ["offset", "limit"])
      : ["offset", "limit"]) {
      if (modifier === "offset") {
        if (length !== undefined && node.offset?._tag === "Literal") {
          const offset = Math.trunc(Number(node.offset.value)) || 0;
          length = offset < 0 ? Math.min(length, -offset) : Math.max(0, length - offset);
        } else if (node.offset || (node._tag === "For" && node.offsetContinue)) length = undefined;
      } else if (modifier === "limit") {
        if (length !== undefined && node.limit?._tag === "Literal") {
          const limit = Math.trunc(Number(node.limit.value)) || 0;
          length = limit < 0 ? Math.max(0, length + limit) : Math.min(length, limit);
        } else if (node.limit) length = undefined;
      }
    }
  }
  return {
    body: length === undefined || length > 0,
    empty,
    repeat: length === undefined || length > 1,
  };
}

/** Shadow bindings invalidate caller refinements for that name and all its paths. */
export function shadow<T>(flow: Flow<T>, name: string, value: T): void {
  for (const key of flow.locals.keys())
    if (key === `@${name}` || key.startsWith(`@${name}.`) || key.startsWith(`@${name}[`))
      flow.locals.delete(key);
  flow.locals.set(name, value);
}
