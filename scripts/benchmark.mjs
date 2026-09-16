import { performance } from "node:perf_hooks";
import { Effect, Stream } from "effect";
import * as Liquid from "../dist/Liquid.js";
import * as T from "../dist/Type.js";

const source = "{% for p in products %}{{p.name | upcase}};{% endfor %}";
const context = { products: Array.from({ length: 100 }, (_, i) => ({ name: `Product ${i}` })) };
const doc = await Effect.runPromise(Liquid.parse(source));
const tasks = {
  parse: Liquid.parse(source),
  render: Liquid.render(doc, context),
  analyze: Liquid.analyze(doc),
  check: Liquid.check(doc, T.record({ products: T.array(T.record({ name: T.string })) })),
  firstChunk: Stream.runCollect(Liquid.renderStream(doc, context).pipe(Stream.take(1))),
};
const results = {};
for (const [name, effect] of Object.entries(tasks)) {
  const runnable = effect.pipe(Effect.provide(Liquid.layer));
  for (let i = 0; i < 10; i++) await Effect.runPromise(runnable);
  const start = performance.now();
  for (let i = 0; i < 100; i++) await Effect.runPromise(runnable);
  results[name] = { iterations: 100, millisecondsPerIteration: (performance.now() - start) / 100 };
}
process.stdout.write(
  `${JSON.stringify({ runtime: process.version, sourceCodeUnits: source.length, products: context.products.length, results, rssBytes: process.memoryUsage().rss }, null, 2)}\n`,
);
