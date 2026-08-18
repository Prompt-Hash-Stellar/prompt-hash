import { Request, Response } from "express";
import {
  createContentCommitment,
  verifyContentCommitment,
  createSimhashFingerprint,
  simhashSimilarity,
  hammingDistance,
  normalizePrompt,
  normalizeMultilingual,
  normalizeCodePrompt,
  verifyFingerprintAlgorithm,
  SUPPORTED_ALGORITHMS,
  FINGERPRINT_ALGORITHM_VERSION,
} from "../services/fingerprint";
import Prompt from "../models/Prompt";
import { scanForSimilarity } from "../services/similarityDetection";

export async function computeFingerprint(req: Request, res: Response) {
  try {
    const { text, algorithmVersion } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text is required" });
    }
    const version = algorithmVersion ?? FINGERPRINT_ALGORITHM_VERSION;
    const result = createContentCommitment(text, version);
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  }
}

export async function verifyFingerprint(req: Request, res: Response) {
  try {
    const { text, commitment, algorithmVersion } = req.body;
    if (!text || !commitment) {
      return res.status(400).json({ error: "text and commitment are required" });
    }
    const valid = verifyContentCommitment(text, commitment, algorithmVersion);
    return res.json({ valid });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  }
}

export async function computeSimhash(req: Request, res: Response) {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text is required" });
    }
    const fingerprint = createSimhashFingerprint(text);
    return res.json({ fingerprint: fingerprint.toString(16), bits: 64 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  }
}

export async function compareSimhash(req: Request, res: Response) {
  try {
    const { fingerprintA, fingerprintB } = req.body;
    if (!fingerprintA || !fingerprintB) {
      return res.status(400).json({ error: "fingerprintA and fingerprintB are required" });
    }
    const a = BigInt(`0x${fingerprintA}`);
    const b = BigInt(`0x${fingerprintB}`);
    const distance = hammingDistance(a, b);
    const similarity = simhashSimilarity(a, b);
    return res.json({ hammingDistance: distance, similarity });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(400).json({ error: "Invalid fingerprint format" });
  }
}

export async function scanSimilarity(req: Request, res: Response) {
  try {
    const { promptId, text } = req.body;
    if (!promptId || !text) {
      return res.status(400).json({ error: "promptId and text are required" });
    }
    const result = await scanForSimilarity(promptId, text);
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  }
}

export async function normalizeText(req: Request, res: Response) {
  try {
    const { text, mode } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text is required" });
    }
    let normalized: string;
    switch (mode) {
      case "code":
        normalized = normalizeCodePrompt(text);
        break;
      case "multilingual":
        normalized = normalizeMultilingual(text);
        break;
      default:
        normalized = normalizePrompt(text);
    }
    return res.json({ normalized });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return res.status(500).json({ error: message });
  }
}

export async function listAlgorithms(_req: Request, res: Response) {
  return res.json({ algorithms: SUPPORTED_ALGORITHMS, currentVersion: FINGERPRINT_ALGORITHM_VERSION });
}
