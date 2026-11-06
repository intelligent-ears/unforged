// Remark plugin: a relative link to a repo file that isn't a published doc goes
// to GitHub. Links between published docs stay as .md links for Docusaurus to resolve.
import { existsSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const GITHUB_URL = "https://github.com/intelligent-ears/unforged";

/** What the docs plugin reads, relative to the repo root. */
export const DOCS_INCLUDE = ["README.md", "docs/*.md", "arkiv/*.md", "study/README.md"];
export const DOCS_EXCLUDE = ["docs/prompts.md", "docs/build-plan.md", "CLAUDE.md"];

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

function matchesGlob(path, glob) {
  const pattern = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
  return new RegExp(`^${pattern}$`).test(path);
}

export function isPublished(repoPath) {
  return DOCS_INCLUDE.some((glob) => matchesGlob(repoPath, glob)) && !DOCS_EXCLUDE.includes(repoPath);
}

function isRepoDirectory(repoPath) {
  const absolute = join(REPO_ROOT, repoPath);
  return existsSync(absolute) && statSync(absolute).isDirectory();
}

/** Where a link in `source` (a path from the repo root) should point. */
export function rewriteRepoLink(href, source) {
  if (ABSOLUTE_URL.test(href) || href.startsWith("#") || href.startsWith("/")) return href;

  const [, path, suffix] = href.match(/^([^?#]*)(.*)$/s);
  const repoPath = posix.normalize(posix.join(posix.dirname(source), path)).replace(/\/$/, "");
  if (repoPath.startsWith("..") || isPublished(repoPath)) return href;

  const kind = path.endsWith("/") || isRepoDirectory(repoPath) ? "tree" : "blob";
  const tail = repoPath === "." ? "" : `/${repoPath}`;
  return `${GITHUB_URL}/${kind}/main${tail}${suffix}`;
}

function visitLinks(node, rewrite) {
  if (node.type === "link" || node.type === "definition") node.url = rewrite(node.url);
  for (const child of node.children ?? []) visitLinks(child, rewrite);
}

export default function repoLinks() {
  return (tree, file) => {
    const source = relative(REPO_ROOT, file.path).split(sep).join("/");
    if (source.startsWith("..")) return;
    visitLinks(tree, (url) => rewriteRepoLink(url, source));
  };
}
