import { Effect } from "effect";
import type { Filter, Registry, Signature } from "./Filter.js";
import { empty, isArray, lookup, stringify, type Value } from "./Value.js";

const number = (v: Value | undefined) => Number.parseFloat(stringify(v)) || 0;
const entries: [string, Filter][] = [];
const define = (
  name: string,
  signature: Signature,
  run: (v: Value, a: readonly Value[], n: Readonly<Record<string, Value>>) => Value,
) => entries.push([name, { signature, run: (v, a, n) => Effect.sync(() => run(v, a, n)) }]);
const string = (name: string, fn: (s: string, a: readonly Value[]) => string, min = 0, max = min) =>
  define(name, { input: "any", output: "string", minArgs: min, maxArgs: max }, (v, a) =>
    fn(stringify(v), a),
  );
string("upcase", (s) => s.toUpperCase());
string("downcase", (s) => s.toLowerCase());
string("capitalize", (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase());
string("append", (s, a) => s + stringify(a[0]), 1);
string("prepend", (s, a) => stringify(a[0]) + s, 1);
string("strip", (s) => s.trim());
string("lstrip", (s) => s.trimStart());
string("rstrip", (s) => s.trimEnd());
string("escape", (s) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" })[c]!,
  ),
);
string("replace", (s, a) => s.split(stringify(a[0])).join(stringify(a[1])), 2);
string("remove", (s, a) => s.split(stringify(a[0])).join(""), 1);
define("join", { input: "array", output: "string", minArgs: 0, maxArgs: 1 }, (v, a) =>
  (isArray(v) ? v : [v]).map(stringify).join(a[0] === undefined ? " " : stringify(a[0])),
);
define("split", { input: "any", output: "array", minArgs: 1, maxArgs: 1 }, (v, a) =>
  stringify(v).split(stringify(a[0])),
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
  divided_by: (a: number, b: number) => a / b,
  modulo: (a: number, b: number) => ((a % b) + b) % b,
  at_least: Math.max,
  at_most: Math.min,
}))
  define(
    name,
    { input: "number", output: "number", argument: "number", minArgs: 1, maxArgs: 1 },
    (v, a) => fn(number(v), number(a[0])),
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
    const scale = 10 ** Math.trunc(number(a[0]));
    return Math.round(number(v) * scale) / scale;
  },
);
define("first", { input: "array", output: "unknown", minArgs: 0, maxArgs: 0 }, (v) =>
  isArray(v) ? (v[0] ?? null) : null,
);
define("last", { input: "array", output: "unknown", minArgs: 0, maxArgs: 0 }, (v) =>
  isArray(v) ? (v[v.length - 1] ?? null) : null,
);
define("reverse", { input: "array", output: "array", minArgs: 0, maxArgs: 0 }, (v) =>
  isArray(v) ? [...v].reverse() : [],
);
define("map", { input: "array", output: "array", minArgs: 1, maxArgs: 1 }, (v, a) =>
  isArray(v) ? v.map((x) => lookup(x, a[0]) ?? null) : [],
);
export const registry: Registry = { filters: new Map(entries) };
