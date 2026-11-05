// Mirror URLs. Browser-safe. A mirror is any static host holding a build in a folder named by its
// ref; the host is untrusted, because every byte is verified against the manifest.

const REF = /^[a-z0-9][a-z0-9.-]*$/;
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\\?#]/;
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i; // URL parsers resolve these, which would leave the ref's folder

/** The URL of a served path in a mirror. Throws on anything that could point outside the ref's folder. */
export function gatewayUrl(gateway: string, ref: string, path: string): string {
  assertGateway(gateway);
  if (!REF.test(ref)) throw new Error(`invalid mirror ref ${JSON.stringify(ref)}: must match ${REF.source}`);
  assertPath(path);
  return `${gateway}${ref}${path}`;
}

function assertGateway(gateway: string): void {
  const invalid = (why: string) => new Error(`invalid gateway ${JSON.stringify(gateway)}: ${why}`);

  let url: URL;
  try {
    url = new URL(gateway);
  } catch {
    throw invalid("not a URL");
  }
  if (url.protocol !== "https:") throw invalid("must be https");
  if (!gateway.endsWith("/")) throw invalid('must end in "/"');
  if (/[?#]/.test(gateway)) throw invalid("must not have a query or fragment");
  if (url.username !== "" || url.password !== "") throw invalid("must not have credentials");
  if (url.pathname.includes("//")) throw invalid("must not have a double slash");
  if (url.href !== gateway) throw invalid(`must be written in normal form, ${url.href}`);
}

function assertPath(path: string): void {
  const invalid = (why: string) => new Error(`invalid path ${JSON.stringify(path)}: ${why}`);

  if (!path.startsWith("/")) throw invalid('must start with "/"');
  if (path.includes("//")) throw invalid("must not have a double slash");
  if (UNSAFE_PATH_CHARS.test(path)) throw invalid("must not have a query, fragment, backslash or control character");
  if (path.split("/").some((segment) => DOT_SEGMENT.test(segment))) throw invalid('must not have "." or ".." segments');
}
