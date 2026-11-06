// Signed policies (formats.md §4): the curator signs a policy and its version the way a builder
// signs a statement, so Arkiv is only storage. Additive: the Policy type itself is unchanged.
import { recoverMessageAddress } from "viem";
import { sameAddress } from "./attestation.js";
import { sha256Canonical } from "./hash.js";
import type { Hex, Policy } from "./types.js";

export interface SignedPolicy {
  policy: Policy;
  version: number; // must equal the entity's version attribute
  signature: Hex; // EIP-191 personal_sign over the raw 32-byte policyDigest(policy, version)
}

/** What can sign: a viem account, or anything with the same signMessage. */
export interface MessageSigner {
  signMessage(args: { message: { raw: Hex } }): Promise<Hex>;
}

/** The 32 bytes a curator signs: sha256(canonicalJSON({ policy, version })). */
export async function policyDigest(policy: Policy, version: number): Promise<Hex> {
  return `0x${await sha256Canonical({ policy, version })}`;
}

export async function signPolicy(policy: Policy, version: number, curator: MessageSigner): Promise<SignedPolicy> {
  const signature = await curator.signMessage({ message: { raw: await policyDigest(policy, version) } });
  return { policy, version, signature };
}

/**
 * The recovered signer must be the expected curator, over both the policy and its version.
 * False, never a throw, on malformed input.
 */
export async function verifyPolicy(signed: SignedPolicy, expectedCurator: Hex): Promise<boolean> {
  try {
    if (!Number.isSafeInteger(signed.version)) return false;
    const signer = await recoverMessageAddress({
      message: { raw: await policyDigest(signed.policy, signed.version) },
      signature: signed.signature,
    });
    return sameAddress(signer, expectedCurator);
  } catch {
    return false;
  }
}
