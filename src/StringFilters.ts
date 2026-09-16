import { Effect } from "effect";
import type { Filter, Signature } from "./Filter.js";
import { isArray, stringify, type Value } from "./Value.js";

const entries: [string, Filter][] = [];
const define = (
  name: string,
  run: (value: Value, args: readonly Value[]) => Value,
  minArgs = 0,
  maxArgs = minArgs,
  output: Signature["output"] = "string",
) => {
  entries.push([
    name,
    {
      signature: { input: "any", output, minArgs, maxArgs },
      run: (value, args) => Effect.sync(() => run(value, args)),
    },
  ]);
};
const text = (
  name: string,
  run: (value: string, args: readonly Value[]) => string,
  min = 0,
  max = min,
) => define(name, (value, args) => run(stringify(value), args), min, max);

text("upcase", (value) => value.toUpperCase());
text("downcase", (value) => value.toLowerCase());
text("capitalize", (value) => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase());
text("append", (value, args) => value + stringify(args[0]), 1);
text("prepend", (value, args) => stringify(args[0]) + value, 1);
for (const name of ["strip", "lstrip", "rstrip"] as const) {
  text(
    name,
    (value, args) => {
      if (!args[0])
        return name === "strip"
          ? value.trim()
          : name === "lstrip"
            ? value.trimStart()
            : value.trimEnd();
      const characters = new Set(stringify(args[0]));
      let first = 0,
        last = value.length;
      if (name !== "rstrip") while (first < last && characters.has(value[first]!)) first++;
      if (name !== "lstrip") while (last > first && characters.has(value[last - 1]!)) last--;
      return value.slice(first, last);
    },
    0,
    1,
  );
}
const entities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&#34;",
  "'": "&#39;",
};
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => entities[character]!);
text("escape", escapeHtml);
text("xml_escape", escapeHtml);
const decoded = new Map(Object.entries(entities).map(([character, entity]) => [entity, character]));
text("escape_once", (value) =>
  escapeHtml(value.replace(/&(amp|lt|gt|#34|#39);/g, (entity) => decoded.get(entity)!)),
);
text("replace", (value, args) => value.split(stringify(args[0])).join(stringify(args[1])), 2);
text("remove", (value, args) => value.split(stringify(args[0])).join(""), 1);
for (const name of ["replace_first", "replace_last", "remove_first", "remove_last"] as const) {
  text(
    name,
    (value, args) => {
      const pattern = stringify(args[0]);
      const index = name.endsWith("first") ? value.indexOf(pattern) : value.lastIndexOf(pattern);
      if (index < 0) return value;
      const replacement = name.startsWith("remove") ? "" : stringify(args[1]);
      return value.slice(0, index) + replacement + value.slice(index + pattern.length);
    },
    name.startsWith("remove") ? 1 : 2,
  );
}
text("strip_newlines", (value) => value.replace(/\r?\n/g, ""));
text("newline_to_br", (value) => value.replace(/\r?\n/g, "<br />\n"));
text("normalize_whitespace", (value) => value.replace(/\s+/g, " "));
text("squish", (value) => value.replace(/\s+/g, " ").trim());
const hostString = (value: Value): string =>
  isArray(value) ? value.map(hostString).join(",") : stringify(value);
const numeric = (value: Value | undefined) =>
  Number(
    value == null
      ? 0
      : typeof value === "number" || typeof value === "boolean"
        ? value
        : hostString(value),
  );
define(
  "truncate",
  (value, args) => {
    const source = stringify(value);
    const length = args.length ? numeric(args[0]) : 50;
    const suffix = args.length > 1 ? stringify(args[1]) : "...";
    return source.length <= length ? value : source.substring(0, length - suffix.length) + suffix;
  },
  0,
  2,
  "unknown",
);
text(
  "truncatewords",
  (value, args) => {
    let count = args.length ? numeric(args[0]) : 15;
    if (count <= 0) count = 1;
    const suffix = args.length > 1 ? stringify(args[1]) : "...";
    const words = value.split(/\s+/);
    return words.slice(0, count).join(" ") + (words.length >= count ? suffix : "");
  },
  0,
  2,
);
define(
  "number_of_words",
  (value, args) => {
    const source = stringify(value).trim();
    if (!source) return 0;
    if (args[0] !== "cjk" && args[0] !== "auto") return source.split(/\s+/).length;
    let count = 0,
      inWord = false;
    for (const character of source) {
      if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(character)) {
        count++;
        inWord = false;
      } else if (/\s/u.test(character)) inWord = false;
      else if (!inWord) {
        count++;
        inWord = true;
      }
    }
    return count;
  },
  0,
  1,
  "number",
);

text("strip_html", (source) => {
  // Precompute the final closer positions so malformed openers cannot cause repeated full scans.
  const closers = ["</script>", "</style>", "-->", ">"];
  const last = closers.map((closer) => source.lastIndexOf(closer));
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open < 0) break;
    parts.push(source.slice(cursor, open));
    const kind =
      source.startsWith("<script", open) && last[0]! >= open + 7
        ? 0
        : source.startsWith("<style", open) && last[1]! >= open + 6
          ? 1
          : source.startsWith("<!--", open) && last[2]! >= open + 4
            ? 2
            : 3;
    if (last[kind]! < open + 1) {
      cursor = open;
      break;
    }
    const close = closers[kind]!;
    cursor = source.indexOf(close, open + [7, 6, 4, 1][kind]!) + close.length;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
});
export const filters: readonly (readonly [string, Filter])[] = entries;
