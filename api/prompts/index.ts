import { withObservability } from "../../src/lib/observability/wrapper";
import connectDb from "../../server/src/db/connectDb";
import Prompt from "../../server/src/models/Prompt";
import User from "../../server/src/models/User";

interface CursorPayload {
  lastCreatedAt: string;
  lastId: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(raw: unknown): CursorPayload | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<CursorPayload>;
    if (
      typeof parsed.lastCreatedAt !== "string" ||
      typeof parsed.lastId !== "string"
    ) {
      return null;
    }
    return { lastCreatedAt: parsed.lastCreatedAt, lastId: parsed.lastId };
  } catch {
    return null;
  }
}

async function handler(req: any, res: any) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await connectDb();

    const { category, walletAddress, cursor } = req.query ?? {};

    // Parse and validate cursor
    let cursorData: CursorPayload | null = null;
    if (cursor !== undefined) {
      cursorData = decodeCursor(String(cursor));
      if (!cursorData) {
        return res.status(400).json({ error: "Invalid cursor parameter." });
      }
    }

    // Parse and validate limit
    const rawLimit =
      req.query.limit !== undefined ? Number(req.query.limit) : 20;
    const limit = Math.min(Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 20), 100);

    // Build base query
    const query: Record<string, unknown> = {
      listingStatus: "published",
      isActive: true,
    };

    if (category) {
      query.category = String(category);
    }

    if (walletAddress) {
      const user = await User.findOne({
        walletAddress: String(walletAddress).toLowerCase(),
      });
      if (!user) {
        return res.status(200).json({ prompts: [], nextCursor: null });
      }
      query.owner = user._id;
    }

    // Add cursor filter for stable pagination
    if (cursorData) {
      query.$or = [
        { createdAt: { $lt: new Date(cursorData.lastCreatedAt) } },
        {
          createdAt: new Date(cursorData.lastCreatedAt),
          _id: { $lt: cursorData.lastId },
        },
      ];
    }

    const prompts = await Prompt.find(query)
      .populate("owner", "username walletAddress")
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1); // Fetch one extra to determine hasNextPage

    const hasNextPage = prompts.length > limit;
    const pagePrompts = hasNextPage ? prompts.slice(0, limit) : prompts;

    let nextCursor: string | null = null;
    if (hasNextPage && pagePrompts.length > 0) {
      const last = pagePrompts[pagePrompts.length - 1] as any;
      nextCursor = encodeCursor({
        lastCreatedAt: last.createdAt.toISOString(),
        lastId: last._id.toString(),
      });
    }

    res.status(200).json({ prompts: pagePrompts, nextCursor });
  } catch (error) {
    console.error("Fetch prompts error:", error);
    res.status(500).json({ error: "Failed to fetch prompts" });
  }
}

export default withObservability(handler, "prompts/index");
