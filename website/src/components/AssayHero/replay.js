// The hero's animation, inlined right after its markup so it blanks the hashes
// before the first paint rather than after the bundle hydrates. The server-rendered
// markup is already the final state, so with JS off or reduced motion nothing runs.
export const REPLAY_SCRIPT = `(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const assay = document.querySelector(".uf-assay");
  const rows = [...assay.querySelectorAll(".uf-assay-row")].map((row) => ({
    cells: [...row.querySelectorAll(".uf-hash span")],
    status: row.querySelector(".uf-status"),
  }));
  const [builder1, builder2, served] = rows;

  const CHAR_MS = 24;
  const SECOND_BUILDER_LAG_MS = 220;
  const START_MS = 350;
  const PAUSE_MS = 450;
  const steps = [];
  const at = (time, run) => steps.push({ time, run });
  const show = (cell) => cell.classList.add("shown");
  const settle = (cell) => cell.classList.add("settled");

  // A builder character turns green only once the second builder has matched it.
  builder1.cells.forEach((cell, index) => {
    const first = START_MS + index * CHAR_MS;
    const second = first + SECOND_BUILDER_LAG_MS;
    at(first, () => show(cell));
    at(second, () => {
      show(builder2.cells[index]);
      settle(cell);
      settle(builder2.cells[index]);
    });
  });

  const buildersDone = START_MS + 64 * CHAR_MS + SECOND_BUILDER_LAG_MS;
  at(buildersDone, () => {
    builder1.status.classList.add("settled");
    builder2.status.classList.add("settled");
  });

  const servedStart = buildersDone + PAUSE_MS;
  served.cells.forEach((cell, index) => {
    at(servedStart + index * CHAR_MS, () => {
      show(cell);
      settle(cell);
    });
  });

  // Dropping "running" reveals the markup as written, so the end state can't drift.
  at(servedStart + 64 * CHAR_MS + 200, () => {
    assay.classList.remove("running");
    assay.classList.add("stamped");
  });

  steps.sort((a, b) => a.time - b.time);
  assay.classList.add("running");

  let next = 0;
  const started = performance.now();
  const tick = (now) => {
    while (next < steps.length && steps[next].time <= now - started) steps[next++].run();
    if (next < steps.length) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;
