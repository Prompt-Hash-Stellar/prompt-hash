export async function recordPreview(promptId: string): Promise<void> {
  try {
    const sessionKey = "prompthash_preview_session";
    let sessionId = sessionStorage.getItem(sessionKey);
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      sessionStorage.setItem(sessionKey, sessionId);
    }
    const tokenResponse = await fetch(`/api/prompts/preview/token?promptId=${encodeURIComponent(promptId)}`);
    if (!tokenResponse.ok) return;
    const { token } = await tokenResponse.json();
    await fetch("/api/prompts/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promptId, sessionId, token }),
    });
  } catch {
    // silently fail - analytics should never block UX
  }
}

export interface PreviewStat {
  _id: string;
  title: string;
  previewCount: number;
  salesCount: number;
  price: number;
  isActive: boolean;
}

export interface PreviewStatsResponse {
  totalPreviews: number;
  prompts: PreviewStat[];
}

export async function getPreviewStats(
  walletAddress: string,
): Promise<PreviewStatsResponse> {
  const res = await fetch(
    `/api/prompts/preview/stats?walletAddress=${encodeURIComponent(walletAddress)}`,
  );
  if (!res.ok) {
    throw new Error("Failed to fetch preview stats");
  }
  return res.json();
}
