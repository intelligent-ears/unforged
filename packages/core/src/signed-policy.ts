// Signed policies (formats.md §4): the curator signs a policy the way a builder signs a
// statement, so Arkiv is only storage. Additive: the Policy type itself is unchanged.
import { recoverMessageAddress } from "viem";
import { sameAddress } from "./attestation.js";
import { sha256Canonical } from "./hash.js";
import type { Hex, Policy } from "./types.js";

export interface SignedPolicy {
  policy: Policy;
  signature: Hex; // EIP-191 personal_sign over the raw 32-byte policyDigest(policy)
}

/** What can sign: a viem account, or anything with the same signMessage. */
export interface MessageSigner {
  signMessage(args: { message: { raw: Hex } }): Promise<Hex>;
}

/** The 32 bytes a curator signs: sha256(canonicalJSON(policy)). */
export async function policyDigest(policy: Policy): Promise<Hex> {
  return `0x${await sha256Canonical(policy)}`;
}

export async function signPolicy(policy: Policy, curator: MessageSigner): Promise<SignedPolicy> {
  const signature = await curator.signMessage({ message: { raw: await policyDigest(policy) } });
  return { policy, signature };
}

/** The recovered signer must be the expected curator. False, never a throw, on malformed input. */
export async function verifyPolicy(signed: SignedPolicy, expectedCurator: Hex): Promise<boolean> {
  try {
    const signer = await recoverMessageAddress({
      message: { raw: await policyDigest(signed.policy) },
      signature: signed.signature,
    });
    return sameAddress(signer, expectedCurator);
  } catch {
    return false;
  }
}
