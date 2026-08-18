import type { VercelRequest, VercelResponse } from "@vercel/node";
import { withObservability } from "../../src/lib/observability/wrapper";
import { checkRateLimit } from "../../src/lib/observability/rateLimiter";
import { apiError, ErrorCode } from "../../src/lib/api/errorCodes";
import { verifyChallengeSignature } from "../../src/lib/auth/challenge";

const PINATA_PIN_FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";

function sendPinata(pinataJwt: string, formData: any) {
  return fetch(PINATA_PIN_FILE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${pinataJwt}` },
    body: formData,
  });
}

function validateTimestamp(ts: number): boolean {
  const now = Date.now();
  return Math.abs(now - ts) < 5 * 60 * 1000; // 5 minutes
}

async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json(apiError(ErrorCode.METHOD_NOT_ALLOWED, "Method not allowed."));
    return;
  }

  const pinataJwt = process.env.PINATA_JWT;
  if (!pinataJwt) {
    res.status(500).json(apiError(ErrorCode.CONFIGURATION_ERROR, "Server configuration missing Pinata credentials."));
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

  const { type, name, mimeType, dataBase64, address, signedMessage, timestamp } = body ?? {};

  const clientIp = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown");

  // Rate limit by IP/address
  const idForRate = address ? String(address) : clientIp;
  const authenticated = Boolean(address && signedMessage);
  const rl = await checkRateLimit("upload", idForRate, authenticated);
  if (!rl.success) {
    res.setHeader("X-RateLimit-Limit", rl.limit);
    res.setHeader("X-RateLimit-Remaining", rl.remaining);
    res.setHeader("X-RateLimit-Reset", rl.reset);
    res.status(429).json(apiError(ErrorCode.RATE_LIMIT_IP, "Too many upload requests."));
    return;
  }

  if (!type || !dataBase64 || !name) {
    res.status(400).json(apiError(ErrorCode.MISSING_FIELDS, "Missing upload payload."));
    return;
  }

  // Ownership check: require a signed message of the form "prompt-hash upload:<address>:<timestamp>"
  if (!address || !signedMessage || !timestamp || !validateTimestamp(Number(timestamp))) {
    res.status(401).json(apiError(ErrorCode.UNAUTHORIZED, "Upload must include a recent signed ownership proof."));
    return;
  }

  const expectedMessage = `prompt-hash upload:${String(address)}:${String(timestamp)}`;
  if (!verifyChallengeSignature(String(address), expectedMessage, String(signedMessage))) {
    res.status(401).json(apiError(ErrorCode.INVALID_SIGNATURE, "Invalid upload signature."));
    return;
  }

  // Basic policies
  const buffer = Buffer.from(dataBase64, "base64");
  const maxSize = type === "image" ? 2 * 1024 * 1024 : 64 * 1024; // images 2MB, ciphertext 64KB
  if (buffer.length > maxSize) {
    res.status(413).json(apiError(ErrorCode.PAYLOAD_TOO_LARGE, "Upload exceeds allowed size."));
    return;
  }

  // Validate MIME by magic bytes for common image types if image
  if (type === "image") {
    const header = buffer.slice(0, 8).toString("hex");
    const isPng = header.startsWith("89504e47");
    const isJpeg = header.startsWith("ffd8ff");
    const isGif = header.startsWith("47494638");
    if (!isPng && !isJpeg && !isGif) {
      res.status(415).json(apiError(ErrorCode.INVALID_CONTENT_TYPE, "Unsupported image format."));
      return;
    }
  }

  // Build multipart/form-data to forward to Pinata
  const formData = new (global as any).FormData();
  const blob = new Blob([buffer], { type: mimeType ?? "application/octet-stream" });
  formData.append("file", blob, name);
  formData.append("pinataMetadata", JSON.stringify({ name }));

  try {
    const pinRes = await sendPinata(pinataJwt, formData);
    if (!pinRes.ok) {
      const detail = await pinRes.text().catch(() => "");
      res.status(502).json(apiError(ErrorCode.TEMPORARY_FAILURE, `Pinata upload failed: ${detail}`));
      return;
    }
    const data = await pinRes.json();
    res.status(200).json({ cid: data.IpfsHash, uri: `ipfs://${data.IpfsHash}` });
  } catch (err: any) {
    res.status(500).json(apiError(ErrorCode.TEMPORARY_FAILURE, "Failed to upload to Pinata."));
  }
}

export default withObservability(handler, "ipfs/upload");
