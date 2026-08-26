import { describe, it, expect, vi, beforeEach } from "vitest";
import { uploadCiphertextToIpfs, uploadImageToIpfs } from "./upload";

describe("ipfs upload client", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it("sends ciphertext to server and returns cid", async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: true, json: async () => ({ cid: "QmCid" }) });
    const res = await uploadCiphertextToIpfs("YmFzZTY0", { name: "test" });
    expect(res.cid).toBe("QmCid");
  });

  it("handles server error for ciphertext", async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 401, text: async () => "unauth" });
    await expect(uploadCiphertextToIpfs("YmFzZTY0", { name: "test" })).rejects.toThrow();
  });

  it("uploads image as base64 and returns cid", async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: true, json: async () => ({ cid: "QmImg" }) });
    const blob = new Blob(["hello"], { type: "text/plain" });
    const file = new File([blob], "hello.txt", { type: "text/plain" });
    const res = await uploadImageToIpfs(file as any);
    expect(res.cid).toBe("QmImg");
  });

  it("rejects oversized image response", async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 413, text: async () => "too large" });
    const blob = new Blob(["x".repeat(10)], { type: "text/plain" });
    const file = new File([blob], "big.txt", { type: "text/plain" });
    await expect(uploadImageToIpfs(file as any)).rejects.toThrow();
  });
});
