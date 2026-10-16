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
  if (v == null || Ruby.isSelf(v)) return 0;
  if (typeof v === "string") return Array.from(v).length;
  if (isArray(v)) return v.length;
  if (typeof v === "number" && Number.isInteger(v)) return 8;
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
    if (Ruby.isSelf(v)) return null;
    const t = Ruby.tag(v);
    if (t?.type === "range") return Ruby.lookup(v, name).value ?? null;
    if (t?.type === "hash" && name === "first") return (t.entries as readonly Value[])[0] ?? null;
    if (typeof v === "string" || isArray(v)) return v[name === "first" ? 0 : v.length - 1] ?? null;
    if (name === "first" && v && typeof v === "object" && !t)
      return Object.entries(v as Record<string, Value>)[0] ?? null;
    return null;
  });
function* flatten(values: readonly Value[]): Generator<Value> {
  for (const value of values)
    if (isArray(value)) yield* flatten(value);
    else yield value;
}
const stringSignature = { input: "any", output: "string", minArgs: 0, maxArgs: 0 } as const;
const escaped = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
define("escape", (v) => escaped(Ruby.toString(v)));
define("h", (v) => escaped(Ruby.toString(v)), stringSignature);
define("escape_once", (v) =>
  Ruby.toString(v).replace(/&(?:#\d+|#x[\da-f]+|[a-z][\da-z]*);|[&<>"']/gi, (c) =>
    c.length > 1 ? c : escaped(c),
  ),
);
define("url_decode", (v) => decodeURIComponent(Ruby.toString(v).replace(/\+/g, " ")));
define(
  "replace",
  (v, a) => {
    const value = Ruby.toString(v),
      search = Ruby.toString(a[0]),
      replacement = Ruby.toString(a[1]);
    return search
      ? value.split(search).join(replacement)
      : replacement + Array.from(value).join(replacement) + replacement;
  },
  { ...stringSignature, minArgs: 1, maxArgs: 2 },
);
define("truncate", (v, a) => {
  if (v === null) return null;
  const value = Array.from(Ruby.toString(v)),
    count = a.length ? Math.trunc(Ruby.numeric(a[0])) : 50,
    suffix = a.length > 1 ? Ruby.toString(a[1]) : "...";
  return value.length > count
    ? value.slice(0, Math.max(0, count - Array.from(suffix).length)).join("") + suffix
    : value.join("");
});
define("truncatewords", (v, a) => {
  if (v === null) return null;
  const value = Ruby.toString(v),
    count = a.length ? Math.max(1, Math.trunc(Ruby.numeric(a[0]))) : 15,
    suffix = a.length > 1 ? Ruby.toString(a[1]) : "...",
    words = value.trim().split(/[ \t\r\n\f\v]+/);
  return words.length > count ? words.slice(0, count).join(" ") + suffix : value;
});
const defaultFilter = filters.get("default")!;
filters.set("default", {
  signature: { ...defaultFilter.signature!, minArgs: 0 },
  run: (v, a, n) =>
    Effect.succeed(
      v == null ||
        (v === false && n.allow_false !== true) ||
        (typeof v === "object" && !Ruby.tag(v) && Object.keys(v).length === 0) ||
        v === ""
        ? (a[0] ?? null)
        : v,
    ),
});
for (const name of ["base64_url_safe_encode", "base64_url_safe_decode"]) {
  const original = filters.get(name.endsWith("encode") ? "base64_encode" : "base64_decode")!;
  if (!("expression" in original))
    filters.set(name, {
      ...original,
      run: (v, a, n, c) =>
        original
          .run(v, a, n, c)
          .pipe(
            Effect.map((value) =>
              name.endsWith("encode")
                ? Ruby.toString(value).replace(/\+/g, "-").replace(/\//g, "_")
                : value,
            ),
          ),
    });
}
define("flatten", (v) => [...flatten(sequence(v))], {
  input: "any",
  output: "array",
  minArgs: 0,
  maxArgs: 0,
});
const readProperty = (v: Value, key: Value | undefined): Value | undefined => {
  const result = Ruby.lookup(v, key, false);
  if (result.found) return result.value;
  if (typeof v === "string") {
    const name = Ruby.toString(key);
    return name ? (v.includes(name) ? name : undefined) : "";
  }
  return lookup(v, key);
};
define("map", (v, a) => [...flatten(sequence(v))].map((item) => readProperty(item, a[0]) ?? null));
define(
  "compact",
  (v, a) =>
    sequence(v).filter((item) => (a[0] == null ? item != null : readProperty(item, a[0]) != null)),
  { input: "any", output: "array", minArgs: 0, maxArgs: 1 },
);
for (const name of ["sort", "sort_natural"])
  define(name, (v, a) =>
    [...flatten(sequence(v))].sort((l, r) => {
      let x = a[0] == null ? l : readProperty(l, a[0]),
        y = a[0] == null ? r : readProperty(r, a[0]);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      if (name === "sort_natural") {
        x = Ruby.toString(x).toLowerCase();
        y = Ruby.toString(y).toLowerCase();
      } else if (Ruby.isNumeric(x) && Ruby.isNumeric(y)) {
        x = Ruby.numeric(x);
        y = Ruby.numeric(y);
      } else if (typeof x === "object" || typeof y === "object") {
        if (Ruby.equal(x, y)) return 0;
        return 0;
      }
      return x < y ? -1 : x > y ? 1 : 0;
    }),
  );
define(
  "uniq",
  (v, a) => {
    const seen = new Set<string>();
    return [...flatten(sequence(v))].filter((item) => {
      const key = JSON.stringify(a[0] == null ? item : readProperty(item, a[0]));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },
  { input: "any", output: "array", minArgs: 0, maxArgs: 1 },
);
for (const name of ["where", "reject", "find", "find_index", "has"])
  define(name, (v, a) => {
    const values = [...flatten(sequence(v))],
      matches = (item: Value) => {
        const value = readProperty(item, a[0]);
        return a[1] == null ? value != null && value !== false : Ruby.equal(value, a[1]);
      };
    if (name === "find") return values.find(matches) ?? null;
    if (name === "find_index") {
      const i = values.findIndex(matches);
      return i < 0 ? null : i;
    }
    if (name === "has") return values.some(matches);
    return values.filter((item) => matches(item) === (name === "where"));
  });

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

define("strip_html", (v) => {
  const input = Ruby.toString(v),
    lower = input.toLowerCase(),
    pattern = /<!--|<script\b|<style\b/gi;
  const closers = { script: "</script>", style: "</style>", comment: "-->" };
  const last = {
    script: lower.lastIndexOf(closers.script),
    style: lower.lastIndexOf(closers.style),
    comment: lower.lastIndexOf(closers.comment),
  };
  let cursor = 0,
    text = "",
    match: RegExpExecArray | null;
  while ((match = pattern.exec(input))) {
    const kind =
      match[0] === "<!--"
        ? "comment"
        : match[0].toLowerCase().includes("script")
          ? "script"
          : "style";
    if (last[kind] < pattern.lastIndex) continue;
    const end = lower.indexOf(closers[kind], pattern.lastIndex);
    text += input.slice(cursor, match.index);
    cursor = end + closers[kind].length;
    pattern.lastIndex = cursor;
  }
  text += input.slice(cursor);
  let result = "";
  cursor = 0;
  const final = text.lastIndexOf(">");
  while (cursor < text.length) {
    const start = text.indexOf("<", cursor);
    if (start < 0 || start > final) {
      result += text.slice(cursor);
      break;
    }
    result += text.slice(cursor, start);
    cursor = text.indexOf(">", start) + 1;
  }
  return result;
});
