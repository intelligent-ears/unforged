// Where a dapp's own files live: its policy origins, and the recovery mirror's folder for each
// accepted release (extension.md "Recovery origin"). Pure, so it is unit-tested directly.
import type { AcceptedRelease } from "@unforged/core";
import { gatewayUrl } from "@unforged/registry";
import { originOf } from "./classify.js";
import type { Snapshot } from "./decide.js";

/** A place a tab's top-level document can come from, and whose files are checked. */
export interface Site {
  dapp: string;
  /** URL prefix of the dapp's own files: "<origin>/" on a policy origin, "<gateway><ref>/" on a mirror. */
  base: string;
  /** On a mirror: the one release whose files that folder holds. */
  mirror?: AcceptedRelease;
}

/**
 * gatewayUrl with its rules, except that the gateway may also be http (formats.md §4):
 * integrity comes from the manifest hashes, not the transport.
 */
export function mirrorUrl(gateway: string, ref: string, path: string): string {
  const http = gateway.startsWith("http://");
  const url = gatewayUrl(http ? `https://${gateway.slice("http://".length)}` : gateway, ref, path);
  return http ? `http://${url.slice("https://".length)}` : url;
}

/** "<gateway><ref>/", or undefined when recovery is off ("TODO", missing) or the values are unsafe. */
export function mirrorBase(gateway: string | undefined, ref: string): string | undefined {
  if (!gateway || gateway === "TODO") return undefined;
  try {
    return mirrorUrl(gateway, ref, "/");
  } catch {
    return undefined;
  }
}

/** The site a top-level document at this URL belongs to, if any. Policy origins come first. */
export function siteFor(snapshot: Snapshot, url: string | undefined): Site | undefined {
  const origin = originOf(url);
  if (url === undefined || origin === undefined) return undefined;
  const dapps = Object.entries(snapshot.dapps);
  for (const [dapp, { policy }] of dapps) {
    if (policy.origins.includes(origin)) return { dapp, base: `${origin}/` };
  }
  const href = new URL(url).href;
  for (const [dapp, { policy, releases }] of dapps) {
    for (const release of releases) {
      for (const ref of release.swarmRefs) {
        const base = mirrorBase(policy.recovery?.gateway, ref);
        if (base !== undefined && href.startsWith(base)) return { dapp, base, mirror: release };
      }
    }
  }
  return undefined;
}

/**
 * The served path of a URL inside a site ("/" and up, decoded, no query), or undefined if the URL
 * is outside it. On a mirror that is the part after the ref, like gatewayUrl's path argument.
 */
export function pathIn(site: Site, url: string): string | undefined {
  const target = new URL(url);
  const base = new URL(site.base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) return undefined;
  return decodeURIComponent(target.pathname.slice(base.pathname.length - 1));
}

/**
 * Where "Open verified copy" goes: the mirror folder of the tab's locked release, or else of the
 * newest accepted release that has one, at the path the tab was on.
 */
export function verifiedCopyUrl(
  snapshot: Snapshot,
  dapp: string | undefined,
  lock: AcceptedRelease | undefined,
  path: string,
): { url: string } | { error: string } {
  const entry = dapp === undefined ? undefined : snapshot.dapps[dapp];
  if (!entry) return { error: "this tab isn't on a dapp Unforged knows" };
  const gateway = entry.policy.recovery?.gateway;
  const release = [lock, ...entry.releases].find((r) => r !== undefined && r.swarmRefs.length > 0);
  const ref = release?.swarmRefs[0];
  if (ref === undefined || mirrorBase(gateway, ref) === undefined) return { error: "no verified copy of this dapp is mirrored" };
  try {
    return { url: mirrorUrl(gateway, ref, path) };
  } catch {
    return { url: mirrorUrl(gateway, ref, "/") }; // the path can't be used safely; open the start page
  }
}
