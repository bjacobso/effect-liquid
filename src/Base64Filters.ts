import { Effect } from "effect";
import type { NativeFilter } from "./Filter.js";
import { stringify } from "./Value.js";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const encoder = new TextEncoder();
// Preserve a leading BOM, just as other decoded UTF-8 characters are preserved.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function encode(text: string): string {
  const bytes = encoder.encode(text);
  const parts: string[] = [];
  let chunk = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const word = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    chunk += alphabet[(word >>> 18) & 63]! + alphabet[(word >>> 12) & 63]!;
    chunk += i + 1 < bytes.length ? alphabet[(word >>> 6) & 63]! : "=";
    chunk += i + 2 < bytes.length ? alphabet[word & 63]! : "=";
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  parts.push(chunk);
  return parts.join("");
}

function decode(text: string): string {
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let count = 0;
  let pending = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    // The pinned Node oracle reads the low byte of each UTF-16 code unit.
    const code = text.charCodeAt(i) & 255;
    if (code === 61) break;
    const digit = code === 45 ? 62 : code === 95 ? 63 : alphabet.indexOf(String.fromCharCode(code));
    if (digit < 0) continue;
    pending = (pending << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[count++] = pending >>> bits;
      pending &= (1 << bits) - 1;
    }
  }
  return decoder.decode(bytes.subarray(0, count));
}

const operations: readonly (readonly [string, (text: string) => string])[] = [
  ["base64_encode", encode],
  ["base64_decode", decode],
];
export const filters: readonly (readonly [string, NativeFilter])[] = operations.map(
  ([name, operation]) => [
    name,
    {
      signature: { input: "any", output: "string", minArgs: 0, maxArgs: 0 },
      run: (value) => Effect.sync(() => operation(stringify(value))),
    },
  ],
);
