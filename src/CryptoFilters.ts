import { Effect } from "effect";
import { BuiltinFilterError } from "./Diagnostic.js";
import type { NativeFilter } from "./Filter.js";
import { stringify } from "./Value.js";

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

const digest = (text: string) =>
  Effect.tryPromise({
    try: async () => hex(await crypto.subtle.digest("SHA-256", encoder.encode(text))),
    catch: (cause) => new BuiltinFilterError({ message: String(cause) }),
  });

const hmac = (text: string, key: string) =>
  Effect.tryPromise({
    try: async () => {
      // HMAC pads an empty key with zero bytes. Web Crypto rejects zero-length raw keys.
      const bytes = key ? encoder.encode(key) : new Uint8Array(64);
      const imported = await crypto.subtle.importKey(
        "raw",
        bytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return hex(await crypto.subtle.sign("HMAC", imported, encoder.encode(text)));
    },
    catch: (cause) => new BuiltinFilterError({ message: String(cause) }),
  });

export const filters: readonly (readonly [string, NativeFilter<BuiltinFilterError>])[] = [
  [
    "sha256",
    {
      signature: { input: "any", output: "string", minArgs: 0, maxArgs: 0 },
      run: (value) => digest(stringify(value)),
    },
  ],
  [
    "hmac_sha256",
    {
      signature: { input: "any", output: "string", minArgs: 0, maxArgs: 1 },
      run: (value, args) => hmac(stringify(value), stringify(args[0])),
    },
  ],
];
