import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Layer, Schema, Stream } from "effect";
import { build } from "esbuild";
import { expect, it } from "vitest";
import * as Liquid from "../src/Liquid.js";
import { fileLoader } from "../src/node.js";
import * as Render from "../src/Render.js";
import { decode, fromSchema } from "../src/Schema.js";
import * as Loader from "../src/TemplateLoader.js";
import * as T from "../src/Type.js";

it("projects decoded schema output and validates input explicitly", async () => {
  const schema = Schema.Struct({
    user: Schema.Struct({ name: Schema.String }),
    count: Schema.NumberFromString,
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const projection = yield* fromSchema(schema);
      const doc = yield* Liquid.parse("{{user.name}}:{{ count | plus: 1 }}");
      const checked = yield* Liquid.check(doc, projection.type);
      const data = yield* decode(schema, { user: { name: "Ada" }, count: "2" });
      const output = yield* Liquid.render(doc, data);
      return { projection, checked, output };
    }).pipe(Effect.provide(Liquid.layer)),
  );
  expect(result.projection.coverage).toBe("complete");
  expect(result.checked.passed).toBe(true);
  expect(result.output).toBe("Ada:3");
});
it("does not execute schema refinement or transformation handlers when projecting", async () => {
  let calls = 0;
  const schema = Schema.String.pipe(
    Schema.filter(() => {
      calls++;
      return true;
    }),
  );
  await Effect.runPromise(fromSchema(schema));
  expect(calls).toBe(0);
});
it("projects optional records and arrays", async () => {
  const schema = Schema.Struct({
    users: Schema.Array(Schema.Struct({ name: Schema.optional(Schema.String) })),
  });
  const result = await Effect.runPromise(fromSchema(schema));
  expect(result.type).toEqual(
    T.record({ users: T.array(T.record({ name: T.optional(T.string) })) }),
  );
});
it("analyzes partial provenance and missing isolated arguments", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const doc = yield* Liquid.parse('{% render "p", person: user %}');
      return yield* Liquid.analyzeProject(doc);
    }).pipe(Effect.provide(Loader.memory({ p: "{{person.name}}{{missing}}" }))),
  );
  expect(result.externalPaths).toContain("user.name");
  expect(result.externalPaths).not.toContain("missing");
  expect(result.diagnostics[0]?.code).toBe("MissingPartialArgument");
});
it("reports cycles and dynamic dependencies", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const doc = yield* Liquid.parse({ id: "p", text: '{% render "p" %}{% render target %}' });
      return yield* Liquid.analyzeProject(doc);
    }).pipe(Effect.provide(Loader.memory({ p: '{% render "p" %}' }))),
  );
  expect(result.coverage).toBe("partial");
  expect(result.coverageReasons).toHaveLength(2);
});
it("checks partial contracts and caller argument types", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const doc = yield* Liquid.parse('{% render "p", person: user %}');
      return yield* Liquid.checkProject(doc, T.record({ user: T.number }), {
        contracts: { p: T.record({ person: T.record({ name: T.string }) }) },
      });
    }).pipe(Effect.provide(Loader.memory({ p: "{{person.name}}" }))),
  );
  expect(result.passed).toBe(false);
  expect(result.diagnostics.some((d) => d.code === "PartialArgument")).toBe(true);
});
it("checks fully known render dependencies successfully", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const doc = yield* Liquid.parse('{% render "p", person: user %}');
      return yield* Liquid.checkProject(doc, T.record({ user: T.record({ name: T.string }) }));
    }).pipe(Effect.provide(Loader.memory({ p: "{{person.name}}" }))),
  );
  expect(result.passed).toBe(true);
  expect(result.coverage).toBe("complete");
});
it("confines filesystem loading including symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "effect-liquid-"));
  try {
    const root = join(dir, "templates");
    await mkdir(root);
    await writeFile(join(root, "p.liquid"), "hello");
    await writeFile(join(dir, "secret.liquid"), "outside");
    await symlink(join(dir, "secret.liquid"), join(root, "link.liquid"));
    const loader = fileLoader(root, ".liquid").pipe(
      Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
    );
    const render = (text: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* Liquid.render(yield* Liquid.parse(text));
        }).pipe(Effect.provide(Layer.merge(Render.layer(), loader))),
      );
    expect(await render('{% render "p" %}')).toBe("hello");
    await expect(render('{% render "../secret" %}')).rejects.toThrow();
    await expect(render('{% render "link" %}')).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("has identical string and stream output for captures and loops", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const doc = yield* Liquid.parse(
        "{% capture x %}A{% for i in (1..3) %}{{i}}{% endfor %}{% endcapture %}{{x}}/{{x}}",
      );
      return [
        yield* Liquid.render(doc),
        Array.from(yield* Stream.runCollect(Liquid.renderStream(doc))).join(""),
      ];
    }).pipe(Effect.provide(Liquid.layer)),
  );
  expect(result).toEqual(["A123/A123", "A123/A123"]);
});
it("bundles the parser for browsers without runtime or checker imports", async () => {
  const bundle = await build({
    entryPoints: ["src/Parser.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
  });
  expect(
    Object.keys(bundle.metafile!.inputs).some((p) => /src\/(Render|Check|node)\.ts/.test(p)),
  ).toBe(false);
});
it("runs the packaged ESM API and CLI", () => {
  expect(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { parse } from "effect-liquid/Parser"; if (typeof parse !== "function") process.exit(1);',
      ],
      { encoding: "utf8" },
    ),
  ).toBe("");
  const output = JSON.parse(
    execFileSync(process.execPath, ["dist/cli.js", "analyze", "-"], {
      input: "{{ user.name }}",
      encoding: "utf8",
    }),
  );
  expect(output.externalRoots).toEqual(["user"]);
  const bad = spawnSync(process.execPath, ["dist/cli.js", "render", "-"], {
    input: "{{",
    encoding: "utf8",
  });
  expect(bad.status).toBe(1);
  expect(JSON.parse(bad.stdout).error._tag).toBe("ParseError");
});
