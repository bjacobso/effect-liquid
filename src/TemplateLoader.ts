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
export const memory = (
  templates: Readonly<Record<string, string>> = {},
  options: { readonly extension?: string; readonly caseSensitive?: boolean } = {},
) => {
  const key = (name: string) => {
    const path = options.caseSensitive === false ? name.toLowerCase() : name;
    return options.extension && !path.endsWith(options.extension) ? path + options.extension : path;
  };
  const entries =
    options.extension || options.caseSensitive === false
      ? Object.fromEntries(Object.entries(templates).map(([name, text]) => [key(name), text]))
      : templates;
  return Layer.succeed(TemplateLoader, {
    load: (name) => {
      const text = Object.getOwnPropertyDescriptor(entries, key(name))?.value as string | undefined;
      return text === undefined
        ? Effect.fail(new LoadError({ name, message: `Template not found: ${name}` }))
        : Effect.succeed({ id: name, text });
    },
  });
};
