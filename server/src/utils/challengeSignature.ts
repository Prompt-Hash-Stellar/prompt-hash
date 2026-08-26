import { Buffer } from "buffer";
import { Keypair } from "@stellar/stellar-sdk";

/**
 * Verifies a Stellar Ed25519 signature over a challenge message.
 *
 * Returns `false` (rather than throwing) for malformed addresses or signatures
 * so callers can treat verification failures uniformly as "not authorized".
 */
export function verifyChallengeSignature(
  address: string,
  message: string,
  signatureBase64: string,
): boolean {
  try {
    const keypair = Keypair.fromPublicKey(address);
    return keypair.verify(
      Buffer.from(message, "utf8"),
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}
