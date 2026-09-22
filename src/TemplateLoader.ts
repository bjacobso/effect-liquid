import { Context, Effect, Layer } from "effect";
import { LoadError } from "./Diagnostic.js";
import type { Source } from "./Source.js";
export interface Loader {
  readonly load: (
    name: string,
    referrer: string,
    kind: "render" | "include" | "layout",
  ) => Effect.Effect<Source, LoadError>;
}
export class TemplateLoader extends Context.Tag("effect-liquid/TemplateLoader")<
  TemplateLoader,
  Loader
>() {}
export const memory = (templates: Readonly<Record<string, string>> = {}) =>
  Layer.succeed(TemplateLoader, {
    load: (name) => {
      const text = Object.getOwnPropertyDescriptor(templates, name)?.value as string | undefined;
      return text === undefined
        ? Effect.fail(new LoadError({ name, message: `Template not found: ${name}` }))
        : Effect.succeed({ id: name, text });
    },
  });
