import { Effect } from "effect";
import { registry as builtins } from "./Builtins.js";
import { BuiltinFilterError } from "./Diagnostic.js";
import type { Filter, Registry } from "./Filter.js";
import * as Ruby from "./RubyValue.js";
import { isArray, lookup, type Value } from "./Value.js";

const filters = new Map(builtins.filters);
const strings = new Set([
  "squish",
  "normalize_whitespace",
  "number_of_words",
  "upcase",
  "downcase",
  "capitalize",
  "append",
  "prepend",
  "strip",
  "lstrip",
  "rstrip",
  "escape",
  "escape_once",
  "xml_escape",
  "replace",
  "remove",
  "replace_first",
  "replace_last",
  "remove_first",
  "remove_last",
  "truncate",
  "truncatewords",
  "strip_newlines",
  "newline_to_br",
  "strip_html",
  "split",
  "url_encode",
  "url_decode",
  "base64_encode",
  "base64_decode",
  "sha256",
  "hmac_sha256",
]);
for (const name of strings) {
  const filter = filters.get(name);
  if (filter && !("expression" in filter))
    filters.set(name, {
      ...filter,
      run: (v, a, n, c) =>
        filter.run(
          Ruby.toString(v),
          a.map((x) => (x && typeof x === "object" ? Ruby.toString(x) : x)),
          n,
          c,
        ),
    });
}
function define(
  name: string,
  run: (v: Value, args: readonly Value[]) => Value,
  signature = builtins.filters.get(name)?.signature,
): void {
  filters.set(name, {
    ...(signature ? { signature } : {}),
    run: (v, a) =>
      Effect.try({
        try: () => run(v, a),
        catch: (e) => new BuiltinFilterError({ message: String(e) }),
      }),
  });
}
for (const name of ["plus", "minus", "times", "divided_by", "modulo", "at_least", "at_most"]) {
  const signature = builtins.filters.get(name)!.signature!;
  define(
    name,
    (v, a) => Ruby.arithmetic(name, v, a[0]),
    name === "divided_by"
      ? { ...signature, maxArgs: 1, positionalArguments: ["number"] }
      : signature,
  );
}
for (const name of ["abs", "ceil", "floor", "round"])
  define(name, (v, a) => {
    const n = Ruby.numeric(v),
      precision = Math.trunc(Ruby.numeric(a[0]));
    if (name === "ceil") return Math.ceil(n);
    if (name === "floor") return Math.floor(n);
    if (name === "abs") return Ruby.floating(v) ? Ruby.float(Math.abs(n)) : Math.abs(n);
    if (Math.abs(precision) > 1000) throw new Error("Rounding precision limit exceeded");
    const scale = 10 ** precision;
    const r = (Math.sign(n) * Math.round(Math.abs(n) * scale * (1 + Number.EPSILON))) / scale;
    return precision > 0 && Ruby.floating(v) ? Ruby.float(r) : r;
  });
define("sum", (v, a) => {
  let total: Value = 0;
  for (const item of flatten(sequence(v)))
    total = Ruby.arithmetic("plus", total, a[0] == null ? item : (lookup(item, a[0]) ?? 0));
  return total;
});
define("size", (v) => {
  if (v == null) return 0;
  if (typeof v === "string" || isArray(v)) return v.length;
  const t = Ruby.tag(v);
  if (t?.type === "hash" || t?.type === "range") return Ruby.lookup(v, "size").value ?? 0;
  return typeof v === "object" && !t ? Object.keys(v).length : 0;
});
define("join", (v, a) =>
  sequence(v)
    .map(Ruby.toString)
    .join(a[0] == null ? " " : Ruby.toString(a[0])),
);
define("slice", (v, a) => {
  const value = isArray(v) ? v : Ruby.toString(v),
    start = Math.trunc(Ruby.numeric(a[0])),
    length = a.length < 2 ? 1 : Math.trunc(Ruby.numeric(a[1]));
  const from = start < 0 ? value.length + start : start;
  return from < 0 || length < 0 ? (isArray(value) ? [] : "") : value.slice(from, from + length);
});
for (const name of ["first", "last"])
  define(name, (v) => {
    const t = Ruby.tag(v);
    if (t?.type === "range") return Ruby.lookup(v, name).value ?? null;
    if (typeof v === "string" || isArray(v)) return v[name === "first" ? 0 : v.length - 1] ?? null;
    if (name === "first" && v && typeof v === "object" && !t) return Object.entries(v)[0] ?? null;
    return null;
  });
function* flatten(values: readonly Value[]): Generator<Value> {
  for (const value of values)
    if (isArray(value)) yield* flatten(value);
    else yield value;
}
export function sequence(v: Value | undefined): readonly Value[] {
  if (v == null) return [];
  if (isArray(v)) return v;
  const t = Ruby.tag(v);
  if (t?.type === "range") {
    const from = Math.trunc(Ruby.numeric(t.from)),
      length = Math.max(0, Math.trunc(Ruby.numeric(t.to)) - from + (t.exclusive ? 0 : 1));
    if (!Number.isSafeInteger(length) || length > 100000) throw new Error("Range limit exceeded");
    return Array.from({ length }, (_, i) => from + i);
  }
  return [v];
}
export const registry: Registry<BuiltinFilterError> = { filters };
export function forDialect<E, R>(
  registry: Registry<E, R>,
  dialect: "liquidjs" | "ruby" | undefined,
): Registry<E | BuiltinFilterError, R> {
  if (dialect !== "ruby") return registry;
  const merged = new Map<string, Filter<E | BuiltinFilterError, R>>(registry.filters);
  for (const [name, filter] of filters)
    if (registry.filters.get(name) === builtins.filters.get(name)) merged.set(name, filter);
  return { filters: merged };
}
