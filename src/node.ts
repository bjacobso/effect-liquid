import { FileSystem, Path } from "@effect/platform";
import { Effect, Layer } from "effect";
import { LoadError } from "./Diagnostic.js";
import { TemplateLoader } from "./TemplateLoader.js";
/** Requires platform FileSystem and Path layers; no Node imports enter the core. */
export const fileLoader = (root: string, extension = "") =>
  Layer.effect(
    TemplateLoader,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const canonicalRoot = yield* fs
        .realPath(root)
        .pipe(
          Effect.mapError(
            () => new LoadError({ name: root, message: "Cannot resolve template root" }),
          ),
        );
      return {
        load: (name: string, referrer: string) =>
          Effect.gen(function* () {
            const base = referrer.startsWith(canonicalRoot + path.sep)
              ? path.dirname(referrer)
              : canonicalRoot;
            const candidate = path.resolve(base, path.extname(name) ? name : name + extension);
            const resolved = yield* fs
              .realPath(candidate)
              .pipe(
                Effect.mapError(() => new LoadError({ name, message: "Cannot resolve template" })),
              );
            const relative = path.relative(canonicalRoot, resolved);
            if (
              relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative)
            )
              return yield* Effect.fail(
                new LoadError({ name, message: "Template is outside configured root" }),
              );
            const text = yield* fs
              .readFileString(resolved)
              .pipe(
                Effect.mapError(() => new LoadError({ name, message: "Cannot read template" })),
              );
            return { id: resolved, text, revision: text };
          }),
      };
    }),
  );
