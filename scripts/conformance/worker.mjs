import { createHash } from "node:crypto";

const engineName = process.argv[2];
const maxBytes = 2_000_000;
let execute;
function category(error) {
  const message = error.message ?? String(error);
  const name = error._tag ?? error.name ?? "Error";
  if (/unknown filter|undefined filter/i.test(message)) return "unknown-filter";
  if (/unsupported tag|tag .* not found/i.test(message)) return "unknown-tag";
  if (/missing variable|undefined variable/i.test(message)) return "missing-variable";
  if (/limit exceeded|memory|resource|call stack/i.test(message)) return "resource-limit";
  if (/template not found|failed to lookup|cannot resolve|ENOENT/i.test(message)) return "load";
  if (name === "ParseError" || name === "TokenizationError" || name === "SyntaxError")
    return "syntax";
  if (error.code === "InvalidContext") return "invalid-context";
  return "runtime";
}
function failure(error, phase) {
  return {
    kind: "error",
    phase,
    category: category(error),
    name: error._tag ?? error.name ?? "Error",
    message: String(error.message || error.cause?.message || error).slice(0, 2000),
  };
}
function output(value) {
  if (typeof value !== "string")
    return { kind: "non-string", value: JSON.stringify(value)?.slice(0, 2000) };
  const bytes = Buffer.byteLength(value);
  if (bytes > maxBytes) return { kind: "resource-limit", message: "Harness output exceeds 2 MB" };
  return { kind: "output", output: value };
}
if (engineName === "liquidjs") {
  const { Liquid } = await import("liquidjs");
  execute = async (fixture) => {
    let engine, document;
    try {
      engine = new Liquid({
        ...fixture.options,
        templates: { ...fixture.options?.templates, ...fixture.templates },
        cache: false,
      });
      document = engine.parse(fixture.source);
    } catch (e) {
      return failure(e, "parse");
    }
    if (fixture.operation === "parse") return { kind: "parsed" };
    try {
      return output(await engine.render(document, structuredClone(fixture.context ?? {})));
    } catch (e) {
      return failure(e, "render");
    }
  };
} else if (engineName === "effect-liquid") {
  const { Effect, Layer } = await import("effect");
  const Liquid = await import("../../dist/Liquid.js");
  const Render = await import("../../dist/Render.js");
  const Loader = await import("../../dist/TemplateLoader.js");
  const allowed = new Set(["strictFilters", "strictVariables", "globals", "templates", "cache"]);
  const equivalentDefaults = {
    jsTruthy: false,
    ownPropertyOnly: true,
    dynamicPartials: true,
    relativeReference: true,
    extname: "",
    jekyllInclude: false,
  };
  execute = async (fixture) => {
    const options = fixture.options ?? {};
    const unsupported = Object.keys(options).filter(
      (k) =>
        !allowed.has(k) &&
        !(Object.hasOwn(equivalentDefaults, k) && options[k] === equivalentDefaults[k]),
    );
    if (unsupported.length) return { kind: "unsupported-configuration", options: unsupported };
    const parsed = await Effect.runPromise(Effect.either(Liquid.parse(fixture.source)));
    if (parsed._tag === "Left") return failure(parsed.left, "parse");
    if (fixture.operation === "parse") return { kind: "parsed" };
    const services = Layer.merge(
      Render.layer({
        strictFilters: options.strictFilters ?? false,
        strictVariables: options.strictVariables ?? false,
        globals: options.globals ?? {},
        maxOutputBytes: maxBytes,
      }),
      Loader.memory({ ...options.templates, ...fixture.templates }),
    );
    const result = await Effect.runPromise(
      Effect.either(Liquid.render(parsed.right, structuredClone(fixture.context ?? {}))).pipe(
        Effect.provide(services),
      ),
    );
    return result._tag === "Left" ? failure(result.left, "render") : output(result.right);
  };
} else throw new Error(`Unknown engine: ${engineName}`);
process.on("message", async (message) => {
  try {
    const result = await execute(message.fixture);
    if (result.kind === "output") {
      result.sha256 = createHash("sha256")
        .update(Buffer.from(result.output, "utf16le"))
        .digest("hex");
      result.bytes = Buffer.byteLength(result.output);
      if (result.output.length > 4096) {
        result.output = result.output.slice(0, 4096);
        result.truncated = true;
      }
    }
    process.send?.({ id: message.id, result });
  } catch (error) {
    process.send?.({
      id: message.id,
      result: { kind: "worker-error", message: String(error).slice(0, 2000) },
    });
  }
});
process.send?.({ ready: true });
