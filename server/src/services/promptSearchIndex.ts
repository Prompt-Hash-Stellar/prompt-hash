import { Types } from "mongoose";
import { PromptSearchIndex } from "../models/PromptSearchIndex";

export async function indexPromptProjection(prompt: any, creator: string, sourceLedger: number) {
  return PromptSearchIndex.updateOne(
    { promptId: String(prompt.onChainId) },
    { $set: {
      promptId: String(prompt.onChainId), title: prompt.title || "Untitled prompt",
      category: prompt.category || "Other", preview: String(prompt.description || "").slice(0, 280),
      tags: (prompt.tags || []).map((tag: string) => tag.toLowerCase()),
      creator: creator.toLowerCase(), active: prompt.isActive !== false,
      sourceLedger,
    } },
    { upsert: true },
  );
}

function decodeCursor(value?: string) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed.createdAt || !Types.ObjectId.isValid(parsed.id)) throw new Error();
    return { createdAt: new Date(parsed.createdAt), id: new Types.ObjectId(parsed.id) };
  } catch { throw new Error("Invalid search cursor"); }
}

export async function searchPublicPromptIndex(input: { q?: string; category?: string; tag?: string; creator?: string; cursor?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(Number(input.limit) || 20, 50));
  const cursor = decodeCursor(input.cursor);
  const query: Record<string, unknown> = { active: true };
  if (input.q?.trim()) query.$text = { $search: input.q.trim().slice(0, 120) };
  if (input.category) query.category = input.category;
  if (input.tag) query.tags = input.tag.toLowerCase();
  if (input.creator) query.creator = input.creator.toLowerCase();
  if (cursor) query.$or = [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }];

  const rows = await PromptSearchIndex.find(query)
    .select("promptId title category preview tags creator active sourceLedger createdAt")
    .sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last._id })).toString("base64url") : null,
    staleAtLedger: items.reduce((min: number | null, row: any) => min == null ? row.sourceLedger : Math.min(min, row.sourceLedger), null),
  };
}
