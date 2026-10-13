import { performance } from "node:perf_hooks";
import { Effect, Stream } from "effect";
import * as Liquid from "../dist/Liquid.js";
import * as T from "../dist/Type.js";

const source = "{% for p in products %}{{p.name | upcase}};{% endfor %}";
const context = { products: Array.from({ length: 100 }, (_, i) => ({ name: `Product ${i}` })) };
const doc = await Effect.runPromise(Liquid.parse(source));
const largeLoopIterations = 10_000;
const loop = await Effect.runPromise(
  Liquid.parse(`{% for i in (1..${largeLoopIterations}) %}{{ i }}{% endfor %}`),
);
const tasks = {
  parse: { effect: Liquid.parse(source) },
  render: { effect: Liquid.render(doc, context), budgetMilliseconds: 20 },
  analyze: { effect: Liquid.analyze(doc) },
  check: {
    effect: Liquid.check(doc, T.record({ products: T.array(T.record({ name: T.string })) })),
  },
  firstChunk: {
    effect: Stream.runCollect(Liquid.renderStream(doc, context).pipe(Stream.take(1))),
  },
  largeLoopRender: {
    effect: Liquid.render(loop),
    iterations: 10,
    warmup: 3,
    budgetMilliseconds: 200,
  },
  largeLoopStream: {
    effect: Stream.runFold(Liquid.renderStream(loop), "", (a, b) => a + b),
    iterations: 10,
    warmup: 3,
    budgetMilliseconds: 200,
  },
};
const results = {};
for (const [name, task] of Object.entries(tasks)) {
  const runnable = task.effect.pipe(Effect.provide(Liquid.layer));
  const iterations = task.iterations ?? 100;
  for (let i = 0; i < (task.warmup ?? 10); i++) await Effect.runPromise(runnable);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) await Effect.runPromise(runnable);
  const millisecondsPerIteration = (performance.now() - start) / iterations;
  results[name] = {
    iterations,
    millisecondsPerIteration,
    ...(task.budgetMilliseconds === undefined
      ? {}
      : {
          budgetMilliseconds: task.budgetMilliseconds,
          withinBudget: millisecondsPerIteration < task.budgetMilliseconds,
        }),
  };
}
process.stdout.write(
  `${JSON.stringify({ runtime: process.version, sourceCodeUnits: source.length, products: context.products.length, largeLoopIterations, results, rssBytes: process.memoryUsage().rss }, null, 2)}\n`,
);
if (Object.values(results).some((result) => result.withinBudget === false)) process.exitCode = 1;
