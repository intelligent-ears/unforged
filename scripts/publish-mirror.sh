#!/usr/bin/env bash
# Prepares a commit that mirrors a verified build on GitHub Pages. It never pushes:
# it ends by printing the push command for a human to run.
#
#   scripts/publish-mirror.sh <out-dir> <ref> <manifest.json>
#
# Needs a built CLI (pnpm -r build), plus git and curl. Optional environment:
#   UNFORGED_RECIPE         recipe the manifest came from (default recipes/<dapp>@<release>.yaml)
#   UNFORGED_MIRROR_DIR     where to keep the clone (default ~/.cache/unforged/unforged-mirror)
#   UNFORGED_MIRROR_REMOTE  repo to clone (default intelligent-ears/unforged-mirror over https)
set -euo pipefail

BRANCH=gh-pages
DEFAULT_REMOTE=https://github.com/intelligent-ears/unforged-mirror.git
MAX_REF_BYTES=128 # Arkiv's limit for a string attribute

die() {
  echo "publish-mirror: $*" >&2
  exit 1
}

# Runs JS with the CLI's exports as `cli`, and this function's other arguments as `args`.
with_cli() {
  local code=$1
  shift
  node --input-type=module -e "
    const [lib, ...args] = process.argv.slice(1);
    const cli = await import(lib);
    try { ${code} } catch (error) { console.error(error.message); process.exit(1); }
  " -- "$cli_lib" "$@"
}

verify_dir() {
  with_cli 'console.log((await cli.verifyMirrorDir(args[0], args[1])) + " files verified in " + args[0]);' "$1" "$manifest"
}

# Prints one value per line: repo, commit, manifest root.
describe_source() {
  with_cli 'const s = await cli.describeMirrorSource(args[0], args[1]); console.log([s.repo, s.commit, s.manifestRoot].join("\n"));' "$manifest" "$recipe"
}

default_recipe() {
  with_cli 'const { readFileSync } = await import("node:fs"); const m = JSON.parse(readFileSync(args[0], "utf8")); console.log(m.dapp + "@" + m.release + ".yaml");' "$manifest"
}

fetch_license() {
  local slug
  [[ $repo =~ ^https://github\.com/([^/]+/[^/]+)$ ]] || die "only GitHub source repos are supported, not $repo"
  slug=${BASH_REMATCH[1]%.git}
  curl --fail --silent --show-error --location --proto '=https' --max-time 60 \
    --output "$license" "https://raw.githubusercontent.com/$slug/$commit/LICENSE" ||
    die "can't fetch LICENSE from $slug at $commit"
  [[ -s $license ]] || die "LICENSE from $slug at $commit is empty"
  echo "license: $(head -n 1 "$license")"
}

# Leaves the clone clean and on the branch. Never drops a local commit: a diverged branch stops here.
prepare_clone() {
  if [[ -d $mirror_dir/.git ]]; then
    [[ $(git -C "$mirror_dir" remote get-url origin) == "$remote" ]] || die "$mirror_dir is a clone of another repo"
    [[ -z $(git -C "$mirror_dir" status --porcelain) ]] || die "$mirror_dir has uncommitted changes"
  else
    mkdir -p "$(dirname "$mirror_dir")"
    git clone --quiet "$remote" "$mirror_dir"
  fi

  local status=0
  git -C "$mirror_dir" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null || status=$?
  case $status in
    0)
      git -C "$mirror_dir" fetch --quiet origin "$BRANCH"
      if git -C "$mirror_dir" show-ref --verify --quiet "refs/heads/$BRANCH"; then
        git -C "$mirror_dir" switch --quiet "$BRANCH"
        git -C "$mirror_dir" merge --quiet --ff-only "origin/$BRANCH" || die "local $BRANCH has diverged from origin; fix $mirror_dir by hand"
      else
        git -C "$mirror_dir" switch --quiet --create "$BRANCH" "origin/$BRANCH"
      fi
      ;;
    2) # The remote answered, and it has no such branch yet.
      if git -C "$mirror_dir" show-ref --verify --quiet "refs/heads/$BRANCH"; then
        git -C "$mirror_dir" switch --quiet "$BRANCH"
      else
        git -C "$mirror_dir" switch --quiet --orphan "$BRANCH"
      fi
      ;;
    *) die "can't reach the mirror remote" ;;
  esac
}

copy_build() {
  local target=$mirror_dir/$ref
  if [[ -e $target/SOURCE.md ]] && ! grep --quiet --fixed-strings "$root" "$target/SOURCE.md"; then
    die "$ref already holds a different build; attestations may point at it, so pick a new ref"
  fi
  rm -rf "$target" # so files from an earlier copy can't linger
  mkdir -p "$target"
  cp -R "$out_dir/." "$target/"
  verify_dir "$target"

  cp "$license" "$target/LICENSE"
  cat >"$target/SOURCE.md" <<EOF
# $ref

Unmodified build output, mirrored as a recovery copy. The host is untrusted: the Unforged
extension checks every file against the attested manifest.

- Source repo: $repo
- Commit: $commit
- Recipe: $recipe_label
- Manifest root: $root
EOF
  : >"$mirror_dir/.nojekyll" # otherwise GitHub Pages hides the _next/ folders
}

commit_copy() {
  # -f: a global gitignore must not drop files from the mirror. autocrlf: the bytes stay as verified.
  git -C "$mirror_dir" -c core.autocrlf=false add --all --force -- "$ref" .nojekyll
  if git -C "$mirror_dir" diff --cached --quiet; then
    echo "nothing new to commit for $ref"
  else
    git -C "$mirror_dir" -c core.autocrlf=false commit --quiet -m "Mirror $ref"
    echo "committed: $(git -C "$mirror_dir" log -1 --format='%h %s')"
  fi
}

[[ $# -eq 3 ]] || die "usage: publish-mirror.sh <out-dir> <ref> <manifest.json>"
out_dir=$1
ref=$2
manifest=$3

[[ -d $out_dir ]] || die "not a directory: $out_dir"
[[ -f $manifest ]] || die "not a file: $manifest"
# Checked first: the ref names a folder this script deletes and recreates.
[[ $ref =~ ^[a-z0-9][a-z0-9.-]*$ ]] || die "invalid ref: $ref"
[[ $ref != none ]] || die 'ref can'\''t be "none": it reads back as no mirror'
((${#ref} <= MAX_REF_BYTES)) || die "ref is over $MAX_REF_BYTES bytes"

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cli_lib=$repo_root/apps/cli/dist/index.js
[[ -f $cli_lib ]] || die "CLI not built: run pnpm -r build"

remote=${UNFORGED_MIRROR_REMOTE:-$DEFAULT_REMOTE}
mirror_dir=${UNFORGED_MIRROR_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/unforged/unforged-mirror}

verify_dir "$out_dir"

recipe=${UNFORGED_RECIPE:-$repo_root/recipes/$(default_recipe)}
[[ -f $recipe ]] || die "no recipe at $recipe; set UNFORGED_RECIPE"
recipe_label=${recipe#"$repo_root"/}
source_info=$(describe_source)
{
  read -r repo
  read -r commit
  read -r root
} <<<"$source_info"

license=$(mktemp)
trap 'rm -f "$license"' EXIT
fetch_license

prepare_clone
copy_build
commit_copy

echo
echo "Nothing was pushed. Check it, then run:"
printf '  git -C %q push origin %s\n' "$mirror_dir" "$BRANCH"
