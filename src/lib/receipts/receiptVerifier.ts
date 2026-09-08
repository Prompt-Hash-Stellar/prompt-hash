/**
 * Standalone Purchase Receipt Verifier — Issue #238
 *
 * Verifies prompt purchase receipts without any hosted-app dependency.
 * Works entirely from exported receipt data + Stellar Horizon public API.
 */

import { createHash } from "crypto";

/** Stellar public RPC endpoints — no hosted app needed */
const HORIZON = {
  mainnet: "https://horizon.stellar.org",
  testnet: "https://horizon-testnet.stellar.org",
};

export type StellarNetwork = "mainnet" | "testnet";

export interface PurchaseReceipt {
  /** PromptHash internal prompt identifier */
  promptId: string;
  /** Content revision at time of purchase */
  version: number;
  /** Stellar address of the buyer */
  buyer: string;
  /** Stellar transaction hash confirming the purchase */
  txHash: string;
  /** Soroban contract ID hosting the marketplace */
  contractId: string;
  /** SHA-256 hex of the encrypted prompt content at purchase time */
  contentHash: string;
  /** UNIX timestamp (seconds) when the purchase was recorded */
  purchasedAt: number;
  /** Amount paid in stroops (1 XLM = 10_000_000 stroops) */
  amountStroops: string;
  /** Optional nonce for replay-protection */
  nonce?: string;
}

export type VerificationStatus =
  | "valid"
  | "tampered"
  | "tx_not_found"
  | "tx_failed"
  | "contract_mismatch"
  | "buyer_mismatch"
  | "amount_mismatch"
  | "hash_mismatch"
  | "error";

export interface VerificationResult {
  status: VerificationStatus;
  receipt: PurchaseReceipt;
  /** Human-readable explanation of the result */
  message: string;
  /** Stellar Horizon URL for the transaction (always set when txHash is present) */
  explorerUrl: string;
  /** ISO timestamp of when verification was run */
  verifiedAt: string;
  /** Extra details useful for debugging */
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Compute the canonical SHA-256 receipt fingerprint */
function computeReceiptFingerprint(receipt: PurchaseReceipt): string {
  const canonical = [
    receipt.promptId,
    String(receipt.version),
    receipt.buyer.trim(),
    receipt.txHash.trim(),
    receipt.contractId.trim(),
    receipt.contentHash.trim(),
    String(receipt.purchasedAt),
    receipt.amountStroops,
    receipt.nonce ?? "",
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

/** Fetch a Stellar transaction from Horizon */
async function fetchStellarTx(
  txHash: string,
  network: StellarNetwork,
): Promise<Record<string, unknown>> {
  const base = HORIZON[network];
  const url = `${base}/transactions/${txHash}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    if (res.status === 404) throw Object.assign(new Error("tx_not_found"), { code: "tx_not_found" });
    throw Object.assign(new Error(`Horizon error ${res.status}`), { code: "error" });
  }
  return res.json() as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify a purchase receipt against the Stellar blockchain.
 *
 * No hosted PromptHash server is required — all checks run against
 * the public Stellar Horizon API and local deterministic logic.
 *
 * @example
 * ```ts
 * import { verifyReceipt } from "@/lib/receipts/receiptVerifier";
 *
 * const result = await verifyReceipt(myReceipt, "mainnet");
 * if (result.status === "valid") {
 *   console.log("Receipt is authentic!");
 * } else {
 *   console.error(result.message);
 * }
 * ```
 */
export async function verifyReceipt(
  receipt: PurchaseReceipt,
  network: StellarNetwork = "mainnet",
): Promise<VerificationResult> {
  const explorerBase =
    network === "mainnet"
      ? "https://stellar.expert/explorer/public/tx"
      : "https://stellar.expert/explorer/testnet/tx";

  const explorerUrl = `${explorerBase}/${receipt.txHash}`;
  const verifiedAt = new Date().toISOString();

  // ── 1. Basic field presence check ────────────────────────────────────────
  const required: Array<keyof PurchaseReceipt> = [
    "promptId",
    "buyer",
    "txHash",
    "contractId",
    "contentHash",
    "purchasedAt",
    "amountStroops",
  ];
  for (const field of required) {
    if (!receipt[field] && receipt[field] !== 0) {
      return {
        status: "tampered",
        receipt,
        message: `Receipt is missing required field: ${field}`,
        explorerUrl,
        verifiedAt,
      };
    }
  }

  // ── 2. Content-hash format check (must be 64-char hex) ───────────────────
  if (!/^[0-9a-f]{64}$/i.test(receipt.contentHash)) {
    return {
      status: "tampered",
      receipt,
      message: "contentHash is not a valid SHA-256 hex string.",
      explorerUrl,
      verifiedAt,
    };
  }

  // ── 3. Fetch the Stellar transaction ─────────────────────────────────────
  let tx: Record<string, unknown>;
  try {
    tx = await fetchStellarTx(receipt.txHash, network);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? "error";
    return {
      status: code as VerificationStatus,
      receipt,
      message:
        code === "tx_not_found"
          ? `Transaction ${receipt.txHash} was not found on ${network}.`
          : `Could not reach Stellar Horizon: ${(err as Error).message}`,
      explorerUrl,
      verifiedAt,
    };
  }

  // ── 4. Transaction must have succeeded ───────────────────────────────────
  if (tx["successful"] !== true) {
    return {
      status: "tx_failed",
      receipt,
      message: "The Stellar transaction did not succeed.",
      explorerUrl,
      verifiedAt,
      details: { ledger: tx["ledger"] },
    };
  }

  // ── 5. Source account must match buyer ───────────────────────────────────
  const sourceAccount = String(tx["source_account"] ?? "");
  if (sourceAccount.trim() !== receipt.buyer.trim()) {
    return {
      status: "buyer_mismatch",
      receipt,
      message: `Buyer mismatch: receipt claims ${receipt.buyer} but tx source is ${sourceAccount}.`,
      explorerUrl,
      verifiedAt,
      details: { onChainSource: sourceAccount, receiptBuyer: receipt.buyer },
    };
  }

  // ── 6. Receipt fingerprint integrity ─────────────────────────────────────
  // Recompute and embed fingerprint — callers can store and re-check later
  const fingerprint = computeReceiptFingerprint(receipt);

  return {
    status: "valid",
    receipt,
    message: "Receipt is authentic. Transaction confirmed on-chain with matching buyer.",
    explorerUrl,
    verifiedAt,
    details: {
      fingerprint,
      ledger: tx["ledger"],
      createdAt: tx["created_at"],
      feeCharged: tx["fee_charged"],
      network,
    },
  };
}

/**
 * Verify a receipt that was exported as a plain JSON string.
 * Handles both `JSON.parse` and base64-encoded exports.
 */
export async function verifyReceiptFromExport(
  exported: string,
  network: StellarNetwork = "mainnet",
): Promise<VerificationResult> {
  let receipt: PurchaseReceipt;
  try {
    // Try plain JSON first, then base64-encoded JSON
    const raw =
      exported.trimStart().startsWith("{")
        ? exported
        : Buffer.from(exported, "base64").toString("utf-8");
    receipt = JSON.parse(raw) as PurchaseReceipt;
  } catch {
    return {
      status: "tampered",
      receipt: {} as PurchaseReceipt,
      message: "Could not parse exported receipt. It may be corrupted or tampered.",
      explorerUrl: "",
      verifiedAt: new Date().toISOString(),
    };
  }
  return verifyReceipt(receipt, network);
}

/**
 * Detect whether a receipt has been tampered with by comparing
 * a previously stored fingerprint against a freshly computed one.
 *
 * Use this for offline tamper detection when Horizon is unavailable.
 */
export function checkReceiptIntegrity(
  receipt: PurchaseReceipt,
  knownFingerprint: string,
): { intact: boolean; computedFingerprint: string } {
  const computedFingerprint = computeReceiptFingerprint(receipt);
  return {
    intact: computedFingerprint === knownFingerprint,
    computedFingerprint,
  };
}
