#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import * as Liquid from "./Liquid.js";
import { isType } from "./Type.js";

const usage =
  "Usage: effect-liquid <parse|analyze|render|check> <file|-> [--context file.json] [--contract file.json]\nOutputs JSON; exit 0 success, 1 findings/failure, 2 usage error.";
const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}
const [command, file, ...flags] = args;
if (
  !command ||
  !["parse", "analyze", "render", "check"].includes(command) ||
  !file ||
  flags.length % 2 !== 0 ||
  flags.some((f, i) => i % 2 === 0 && !["--context", "--contract"].includes(f))
) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}
const options = new Map<string, string>();
for (let i = 0; i < flags.length; i += 2) options.set(flags[i]!, flags[i + 1]!);
const read = (name: string) =>
  Effect.tryPromise({
    try: () => readFile(name, "utf8"),
    catch: (error) => ({ code: "ReadError", message: String(error) }),
  });
const json = (text: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () => ({ code: "InvalidJSON", message: "Invalid JSON document" }),
  });
const input =
  file === "-"
    ? Effect.tryPromise({
        try: async () => {
          let text = "";
          for await (const chunk of process.stdin) {
            text += String(chunk);
            if (text.length > 1_000_000) throw new Error("Source length limit exceeded");
          }
          return text;
        },
        catch: (error) => ({ code: "ReadError", message: String(error) }),
      })
    : read(file);
const program = Effect.gen(function* () {
  const text = yield* input;
  const document = yield* Liquid.parse({ id: file, text });
  switch (command) {
    case "parse":
      return document;
    case "analyze":
      return yield* Liquid.analyze(document);
    case "render": {
      const name = options.get("--context");
      const context = name ? yield* Effect.flatMap(read(name), json) : {};
      return { output: yield* Liquid.render(document, context) };
    }
    case "check": {
      const name = options.get("--contract");
      if (!name)
        return yield* Effect.fail({
          code: "MissingContract",
          message: "check requires --contract",
        });
      const contract = yield* Effect.flatMap(read(name), json);
      if (!isType(contract))
        return yield* Effect.fail({
          code: "InvalidContract",
          message: "Expected a serialized effect-liquid/Type contract",
        });
      const result = yield* Liquid.check(document, contract);
      if (!result.passed) process.exitCode = 1;
      return result;
    }
  }
}).pipe(Effect.provide(Liquid.layer));
Effect.runPromise(Effect.either(program))
  .then((result) => {
    if (result._tag === "Left") {
      process.exitCode = 1;
      process.stdout.write(`${JSON.stringify({ error: result.left })}\n`);
    } else process.stdout.write(`${JSON.stringify(result.right)}\n`);
  })
  .catch((error) => {
    process.exitCode = 1;
    process.stderr.write(`${String(error)}\n`);
  });
