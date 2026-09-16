process.send({ ready: true });
process.on("message", ({ id, fixture }) => {
  if (fixture.source === "hang") return;
  if (fixture.source === "crash") process.exit(7);
  process.send({ id, result: { kind: "parsed" } });
});
