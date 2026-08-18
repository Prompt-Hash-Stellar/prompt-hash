/**
 * Client-side IPFS upload helper.
 *
 * The client forwards upload payloads to the authenticated server endpoint
 * `/api/ipfs/upload` which performs validation and pins to Pinata using a
 * server-side secret (`PINATA_JWT`). This keeps long-lived credentials out
 * of browser assets and network requests.
 */
import { toIpfsUri } from "./reference";

export interface IpfsUploadResult {
  cid: string;
  uri: string;
}

function apiUploadPayload(payload: Record<string, any>) {
  return fetch("/api/ipfs/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function uploadCiphertextToIpfs(
  ciphertextBase64: string,
  options?: { name?: string; address?: string; signedMessage?: string; timestamp?: number },
): Promise<IpfsUploadResult> {
  const name = options?.name ?? "prompt-ciphertext.txt";
  const payload = {
    type: "ciphertext",
    name,
    dataBase64: ciphertextBase64,
    address: options?.address,
    signedMessage: options?.signedMessage,
    timestamp: options?.timestamp,
  };

  const res = await apiUploadPayload(payload);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Upload failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const data = await res.json();
  return { cid: data.cid, uri: toIpfsUri(data.cid) };
}

export async function uploadImageToIpfs(file: File, opts?: { address?: string; signedMessage?: string; timestamp?: number }): Promise<IpfsUploadResult> {
  // Read file into base64 to avoid multipart/form parsing in serverless handler
  const buf = await file.arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");
  const payload = {
    type: "image",
    name: file.name,
    mimeType: file.type,
    dataBase64: b64,
    address: opts?.address,
    signedMessage: opts?.signedMessage,
    timestamp: opts?.timestamp,
  };

  const res = await apiUploadPayload(payload);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Upload failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const data = await res.json();
  return { cid: data.cid, uri: toIpfsUri(data.cid) };
}
