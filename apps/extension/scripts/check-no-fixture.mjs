// Build check: unless built with UNFORGED_FIXTURE=1, dist/ must not contain the demo fixture
// snapshot. Enforcement in a normal build uses only what was synced from Arkiv.
import { readdir, readFile } from "node:fs/promises";

const DIST = new URL("../dist/", import.meta.url);
const snapshot = JSON.parse(await readFile(new URL("../fixtures/snapshot.json", import.meta.url), "utf8"));
// Strings only the fixture carries: its manifest root and its placeholder builder addresses.
const markers = Object.values(snapshot.dapps).flatMap((d) => [...d.releases.map((r) => r.manifestRoot), ...d.policy.builders]);

const files = (await readdir(DIST, { recursive: true })).filter((f) => f.endsWith(".js") || f.endsWith(".json"));
const found = [];
for (const file of files) {
  const text = await readFile(new URL(file, DIST), "utf8");
  if (markers.some((m) => text.includes(m))) found.push(file);
}

const fixtureBuild = process.env.UNFORGED_FIXTURE === "1";
if (!fixtureBuild && found.length > 0) {
  console.error(`check-no-fixture: the fixture snapshot is in ${found.join(", ")}; build without UNFORGED_FIXTURE=1 must not bundle it`);
  process.exit(1);
}
if (fixtureBuild && found.length === 0) {
  console.error("check-no-fixture: UNFORGED_FIXTURE=1 but the fixture snapshot is missing from dist/");
  process.exit(1);
}
console.log(`check-no-fixture: ok (${fixtureBuild ? "fixture build" : "no fixture"})`);
