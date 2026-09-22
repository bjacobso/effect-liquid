import { Effect } from "effect";
import { filters as base64Filters } from "./Base64Filters.js";
import { filters as dateFilters } from "./DateFilters.js";
import type { BuiltinFilterError } from "./Diagnostic.js";
import type { Filter, FilterCallContext, Registry, Signature } from "./Filter.js";
import { propertyKeys } from "./PropertyPath.js";
import { filters as stringFilters } from "./StringFilters.js";
import { filters as urlFilters } from "./UrlFilters.js";
import { empty, isArray, lookup, stringify, truthy, type Value } from "./Value.js";

const number = (v: Value | undefined) => numeric(v) || 0;
const entries: [string, Filter<BuiltinFilterError>][] = [
  ...stringFilters,
  ...urlFilters,
  ...base64Filters,
  ...dateFilters,
].map(([name, filter]) => [name, filter]);
const define = (
  name: string,
  signature: Signature,
  run: (
    v: Value,
    a: readonly Value[],
    n: Readonly<Record<string, Value>>,
    context?: FilterCallContext,
  ) => Value | undefined,
) =>
  entries.push([
    name,
    { signature, run: (v, a, n, context) => Effect.sync(() => run(v, a, n, context)) },
  ]);
define("join", { input: "any", output: "string", minArgs: 0, maxArgs: 1 }, (v, a) =>
  array(v)
    .map(hostString)
    .join(a[0] == null ? " " : stringify(a[0])),
);
define("split", { input: "any", output: "array", minArgs: 1, maxArgs: 1 }, (v, a) =>
  split(v, a[0]),
);
define("size", { input: "any", output: "number", minArgs: 0, maxArgs: 0 }, (v) =>
  typeof v === "string" || isArray(v) ? v.length : 0,
);
define("default", { input: "any", output: "input", minArgs: 1, maxArgs: 1 }, (v, a, n) =>
  v === null ||
  ((typeof v === "string" || isArray(v)) && empty(v)) ||
  (v === false && n.allow_false !== true)
    ? (a[0] ?? null)
    : v,
);
for (const [name, fn] of Object.entries({
  plus: (a: number, b: number) => a + b,
  minus: (a: number, b: number) => a - b,
  times: (a: number, b: number) => a * b,
  modulo: (a: number, b: number) => ((a % b) + b) % b,
  at_least: Math.max,
  at_most: Math.min,
}))
  define(
    name,
    { input: "number", output: "number", argument: "number", minArgs: 1, maxArgs: 1 },
    (v, a) => fn(number(v), number(a[0])),
  );
define(
  "divided_by",
  {
    input: "number",
    output: "number",
    positionalArguments: ["number", "boolean"],
    minArgs: 1,
    maxArgs: 2,
  },
  (v, a) => {
    const quotient = number(v) / number(a[0]);
    return number(a[1]) ? Math.floor(quotient) : quotient;
  },
);
for (const [name, fn] of Object.entries({
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
}))
  define(name, { input: "number", output: "number", minArgs: 0, maxArgs: 0 }, (v) => fn(number(v)));
define(
  "round",
  { input: "number", output: "number", argument: "number", minArgs: 0, maxArgs: 1 },
  (v, a) => {
    const scale = 10 ** number(a[0]);
    const scaled = number(v) * scale;
    // Compensate for binary multiplication error at decimal ties, then round
    // the magnitude so negative ties also round away from zero.
    return (Math.sign(scaled) * Math.round(Math.abs(scaled) * (1 + Number.EPSILON))) / scale;
  },
);
define("first", { input: "any", output: "unknown", minArgs: 0, maxArgs: 0 }, (v) =>
  isArray(v) || typeof v === "string" ? (v[0] ?? null) : null,
);
define("last", { input: "any", output: "unknown", minArgs: 0, maxArgs: 0 }, (v) =>
  isArray(v) || typeof v === "string" ? (v[v.length - 1] ?? null) : null,
);
define("reverse", { input: "any", output: "array", minArgs: 0, maxArgs: 0 }, (v) =>
  [...array(v)].reverse(),
);
define("map", { input: "any", output: "array", minArgs: 1, maxArgs: 1 }, (v, a) => {
  const read = propertyReader(a[0]);
  return array(v).map((item) => read(item) ?? null);
});
// These filters coerce nil to an empty sequence and scalars to one item.
function array(value: Value | undefined): readonly Value[] {
  return value == null ? [] : isArray(value) ? value : [value];
}
function hostString(value: Value): string {
  return isArray(value) ? value.map(hostString).join(",") : stringify(value);
}
function propertyReader(
  path: Value | undefined,
  brackets = false,
): (value: Value) => Value | undefined {
  const keys = brackets ? propertyKeys(stringify(path)) : stringify(path).split(".");
  return (value) => keys?.reduce<Value | undefined>((item, key) => lookup(item, key), value);
}
function split(value: Value, separator: Value | undefined): readonly Value[] {
  const text = stringify(value);
  if (!text) return [];
  const result = text.split(stringify(separator));
  while (result.at(-1) === "") result.pop();
  return result;
}
const numeric = (value: Value | undefined): number => {
  if (value == null) return 0;
  if (typeof value === "object" && !isArray(value)) return Number.NaN;
  return Number(isArray(value) ? hostString(value) : value);
};
function same(left: Value | undefined, right: Value | undefined): boolean {
  if (left == null && right == null) return true;
  if (isArray(left) && isArray(right))
    return left.length === right.length && left.every((value, i) => same(value, right[i]));
  return left === right;
}
for (const name of ["sort", "sort_natural"] as const)
  define(name, { input: "any", output: "array", minArgs: 0, maxArgs: 1 }, (v, a) => {
    const key = a[0] ? propertyReader(a[0]) : (item: Value) => item;
    return [...array(v)].sort((left, right) => {
      const x = key(left),
        y = key(right);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      const l =
        name === "sort_natural"
          ? hostString(x).toLowerCase()
          : typeof x === "object"
            ? hostString(x)
            : x;
      const r =
        name === "sort_natural"
          ? hostString(y).toLowerCase()
          : typeof y === "object"
            ? hostString(y)
            : y;
      return l < r ? -1 : l > r ? 1 : 0;
    });
  });
define("sum", { input: "any", output: "number", minArgs: 0, maxArgs: 1 }, (v, a) => {
  const read = a[0] ? propertyReader(a[0]) : (item: Value) => item;
  return array(v).reduce<number>((total, item) => {
    const value = numeric(read(item));
    return total + (Number.isNaN(value) ? 0 : value);
  }, 0);
});
define("compact", { input: "any", output: "array", minArgs: 0, maxArgs: 0 }, (v) =>
  array(v).filter((item) => item !== null),
);
define("concat", { input: "any", output: "array", minArgs: 0, maxArgs: 1 }, (v, a) => [
  ...array(v),
  ...array(a[0]),
]);
define("uniq", { input: "any", output: "array", minArgs: 0, maxArgs: 0 }, (v) => [
  ...new Set(array(v)),
]);
define("push", { input: "any", output: "array", minArgs: 0, maxArgs: 1 }, (v, a) => [
  ...array(v),
  a[0] ?? null,
]);
define("unshift", { input: "any", output: "array", minArgs: 0, maxArgs: 1 }, (v, a) => [
  a[0] ?? null,
  ...array(v),
]);
define("pop", { input: "any", output: "array", minArgs: 0, maxArgs: 0 }, (v) =>
  array(v).slice(0, -1),
);
define("shift", { input: "any", output: "array", minArgs: 0, maxArgs: 0 }, (v) =>
  array(v).slice(1),
);
define("slice", { input: "any", output: "unknown", minArgs: 1, maxArgs: 2 }, (v, a) => {
  if (v === null) return [];
  const value = isArray(v) ? v : stringify(v);
  let start = Math.trunc(numeric(a[0])) || 0;
  const length = a.length < 2 ? 1 : Math.trunc(numeric(a[1])) || 0;
  if (start < 0) start += value.length;
  return start < 0 || length < 0 ? (isArray(value) ? [] : "") : value.slice(start, start + length);
});
for (const name of ["where", "reject", "find", "find_index", "has"] as const)
  define(
    name,
    {
      input: "any",
      output: name === "where" || name === "reject" ? "array" : "unknown",
      minArgs: 1,
      maxArgs: 2,
    },
    (v, a, _named, context) => {
      const values = array(v);
      const read = propertyReader(a[0], true);
      const matches = (item: Value) => {
        const value = read(item);
        if (context?.specialArguments[1] === "empty") return empty(value);
        if (context?.specialArguments[1] === "blank")
          return (
            !truthy(value) || empty(value) || (typeof value === "string" && value.trim() === "")
          );
        if (context?.jekyllWhere) {
          const expected = context.missingArguments[1] ? undefined : a[1];
          return isArray(value)
            ? value.some((member) => same(member, expected))
            : same(value, expected);
        }
        return a.length < 2 || context?.missingArguments[1] ? truthy(value) : same(value, a[1]);
      };
      if (name === "where" || name === "reject")
        return values.filter((item) => matches(item) === (name === "where"));
      const index = values.findIndex(matches);
      return name === "has"
        ? index >= 0
        : name === "find_index"
          ? index < 0
            ? undefined
            : index
          : values[index];
    },
  );
define("group_by", { input: "any", output: "array", minArgs: 1, maxArgs: 1 }, (v, a) => {
  const read = propertyReader(a[0], true);
  const groups = new Map<Value | undefined, Value[]>();
  const values: readonly Value[] = isArray(v)
    ? v
    : typeof v === "string"
      ? v
        ? [v]
        : []
      : v && typeof v === "object"
        ? Object.entries(v).map(([key, item]) => [key, item])
        : [];
  for (const item of values) {
    const key = read(item);
    const members = groups.get(key);
    if (members) members.push(item);
    else groups.set(key, [item]);
  }
  return [...groups].map(([name, items]) => ({ ...(name === undefined ? {} : { name }), items }));
});
define("json", { input: "any", output: "string", minArgs: 0, maxArgs: 1 }, (v, a) =>
  JSON.stringify(v, null, numeric(a[0])),
);
define("to_integer", { input: "any", output: "number", minArgs: 0, maxArgs: 0 }, (v) => numeric(v));
for (const operation of ["where", "reject", "find", "find_index", "has", "group_by"] as const)
  entries.push([
    `${operation}_exp`,
    {
      expression: operation,
      signature: {
        input: "any",
        output:
          operation === "where" || operation === "reject" || operation === "group_by"
            ? "array"
            : "unknown",
        minArgs: 2,
        maxArgs: 2,
      },
    },
  ]);
export const registry: Registry<BuiltinFilterError> = { filters: new Map(entries) };
