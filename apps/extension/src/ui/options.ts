// Options page: one optional field, the Arkiv access key. It is written to storage.local and read
// only by the background's sync. The page never reads it back, so a saved key is never shown.
import { byId } from "./dom.js";

const KEY = "accessKey"; // snapshots.ts STORAGE.accessKey

async function showStatus(): Promise<void> {
  const stored = await browser.storage.local.get(KEY);
  const saved = typeof stored[KEY] === "string" && stored[KEY] !== "";
  byId("key-status").textContent = saved ? "A key is saved." : "No key saved: sync uses the public endpoint.";
}

async function save(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const input = byId<HTMLInputElement>("access-key");
  const key = input.value.trim();
  input.value = "";
  if (key === "") await browser.storage.local.remove(KEY);
  else await browser.storage.local.set({ [KEY]: key });
  await showStatus();
}

byId<HTMLFormElement>("access-key-form").addEventListener("submit", (event) => {
  save(event).catch((error: unknown) => {
    byId("key-status").textContent = `Couldn't save: ${error instanceof Error ? error.message : String(error)}.`;
  });
});
void showStatus();
