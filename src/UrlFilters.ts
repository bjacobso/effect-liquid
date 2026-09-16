import { Effect } from "effect";
import { BuiltinFilterError } from "./Diagnostic.js";
import type { Filter } from "./Filter.js";
import { stringify, type Value } from "./Value.js";

const operations: Record<string, (value: string) => string> = {
  url_encode: (value) => encodeURIComponent(value).replace(/%20/g, "+"),
  url_decode: (value) => decodeURIComponent(value).replace(/\+/g, " "),
  cgi_escape: (value) =>
    encodeURIComponent(value)
      .replace(/%20/g, "+")
      .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`),
  uri_escape: (value) => encodeURI(value).replace(/%5B/g, "[").replace(/%5D/g, "]"),
};
const entries: [string, Filter<BuiltinFilterError>][] = Object.entries(operations).map(
  ([name, operation]) => [
    name,
    {
      signature: { input: "any", output: "string", minArgs: 0, maxArgs: 0 },
      run: (value) =>
        Effect.try({
          try: () => operation(stringify(value)),
          catch: (cause) => {
            if (cause instanceof URIError)
              return new BuiltinFilterError({ message: cause.message });
            throw cause;
          },
        }),
    },
  ],
);
const modes = new Map<string, RegExp>([
  ["default", /[^\p{L}\p{M}\p{Nd}]+/gu],
  ["latin", /[^\p{L}\p{M}\p{Nd}]+/gu],
  ["pretty", /[^\p{L}\p{M}\p{Nd}._~!$&'()+,;=@]+/gu],
  ["ascii", /[^a-zA-Z0-9]+/g],
  ["raw", /\s+/g],
]);
const latin = new Map<string, string>();
for (const [letters, replacement] of [
  ["àáâãäå", "a"],
  ["æ", "ae"],
  ["ç", "c"],
  ["èéêë", "e"],
  ["ìíîï", "i"],
  ["ð", "d"],
  ["ñ", "n"],
  ["òóôõöø", "o"],
  ["ùúûü", "u"],
  ["ýÿ", "y"],
  ["ß", "ss"],
  ["œ", "oe"],
  ["þ", "th"],
  ["ẞ", "SS"],
  ["Œ", "OE"],
  ["Þ", "TH"],
])
  for (const letter of letters!) latin.set(letter, replacement!);
function slug(value: Value, args: readonly Value[]): string {
  const mode = args.length ? stringify(args[0]) : "default";
  const matcher = modes.get(mode);
  let text = stringify(value);
  if (matcher) {
    if (mode === "latin")
      text = Array.from(text, (character) => latin.get(character) ?? character).join("");
    text = text.replace(matcher, "-");
    if (text.startsWith("-")) text = text.slice(1);
    if (text.endsWith("-")) text = text.slice(0, -1);
  }
  return args[1] ? text : text.toLowerCase();
}
entries.push([
  "slugify",
  {
    signature: { input: "any", output: "string", minArgs: 0, maxArgs: 2 },
    run: (value, args) => Effect.sync(() => slug(value, args)),
  },
]);
export const filters: readonly (readonly [string, Filter<BuiltinFilterError>])[] = entries;
