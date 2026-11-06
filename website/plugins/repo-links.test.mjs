import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import repoLinks, { DOCS_EXCLUDE, DOCS_INCLUDE, isPublished, rewriteRepoLink } from "./repo-links.mjs";

const GITHUB = "https://github.com/intelligent-ears/unforged";
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

test("the published set follows the docs include and exclude lists", () => {
  assert.deepEqual(DOCS_INCLUDE, ["README.md", "docs/*.md", "arkiv/*.md", "study/README.md"]);
  for (const path of ["README.md", "docs/demo.md", "arkiv/schema.md", "study/README.md"]) {
    assert.ok(isPublished(path), path);
  }
  for (const path of [...DOCS_EXCLUDE, "CLAUDE.md", "demo/README.md", "docs/sub/page.md", "study/other.md"]) {
    assert.ok(!isPublished(path), path);
  }
});

test("links between published docs stay relative, with their fragments", () => {
  for (const [href, source] of [
    ["docs/demo.md#x", "README.md"],
    ["../arkiv/schema.md", "docs/formats.md"],
    ["threat-model.md#gaps", "docs/demo.md"],
    ["../README.md#run-it", "arkiv/reach.md"],
    ["../study/README.md", "docs/demo.md"],
  ]) {
    assert.equal(rewriteRepoLink(href, source), href);
  }
});

test("other repo files go to GitHub's blob view", () => {
  assert.equal(rewriteRepoLink("../LICENSE", "docs/demo.md"), `${GITHUB}/blob/main/LICENSE`);
  assert.equal(rewriteRepoLink("LICENSE", "README.md"), `${GITHUB}/blob/main/LICENSE`);
  assert.equal(rewriteRepoLink("../demo/policy.json#L2", "docs/demo.md"), `${GITHUB}/blob/main/demo/policy.json#L2`);
  assert.equal(rewriteRepoLink("../study/coverage.py", "arkiv/reach.md"), `${GITHUB}/blob/main/study/coverage.py`);
  assert.equal(rewriteRepoLink("../packages/registry/src/arkiv.ts", "arkiv/schema.md"), `${GITHUB}/blob/main/packages/registry/src/arkiv.ts`);
});

test("private documents link to GitHub and are never published", () => {
  assert.equal(rewriteRepoLink("docs/prompts.md", "README.md"), `${GITHUB}/blob/main/docs/prompts.md`);
  assert.equal(rewriteRepoLink("build-plan.md", "docs/demo.md"), `${GITHUB}/blob/main/docs/build-plan.md`);
  assert.equal(rewriteRepoLink("CLAUDE.md", "README.md"), `${GITHUB}/blob/main/CLAUDE.md`);
});

test("directories go to GitHub's tree view", () => {
  assert.equal(rewriteRepoLink("../study/", "docs/demo.md"), `${GITHUB}/tree/main/study`);
  assert.equal(rewriteRepoLink("docs/", "README.md"), `${GITHUB}/tree/main/docs`);
  assert.equal(rewriteRepoLink("../demo", "docs/demo.md"), `${GITHUB}/tree/main/demo`);
  assert.equal(rewriteRepoLink("..", "docs/demo.md"), `${GITHUB}/tree/main`);
});

test("absolute links, fragments and paths outside the repo are left alone", () => {
  for (const href of ["https://example.com/a.md", "http://intelears.me/unforged/", "mailto:a@example.com", "#local", "/README", "../../etc/passwd"]) {
    assert.equal(rewriteRepoLink(href, "docs/demo.md"), href);
  }
});

test("the remark plugin rewrites inline and reference links, including nested ones", () => {
  const paragraph = {
    type: "paragraph",
    children: [
      { type: "link", url: "../LICENSE", children: [] },
      { type: "strong", children: [{ type: "link", url: "../demo", children: [] }] },
      { type: "link", url: "threat-model.md#gaps", children: [] },
    ],
  };
  const definition = { type: "definition", identifier: "policy", url: "../demo/policy.json" };
  const image = { type: "image", url: "../demo/shot.png" };
  const tree = { type: "root", children: [paragraph, definition, image] };

  repoLinks()(tree, { path: `${REPO_ROOT}/docs/demo.md` });

  assert.equal(paragraph.children[0].url, `${GITHUB}/blob/main/LICENSE`);
  assert.equal(paragraph.children[1].children[0].url, `${GITHUB}/tree/main/demo`);
  assert.equal(paragraph.children[2].url, "threat-model.md#gaps");
  assert.equal(definition.url, `${GITHUB}/blob/main/demo/policy.json`);
  assert.equal(image.url, "../demo/shot.png", "images are not links");
});

test("the remark plugin leaves files outside the repo alone", () => {
  const link = { type: "link", url: "../LICENSE", children: [] };
  repoLinks()({ type: "root", children: [link] }, { path: "/somewhere/else/page.md" });
  assert.equal(link.url, "../LICENSE");
});
