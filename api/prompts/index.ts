import mongoose from "mongoose";
import { withObservability } from "../../src/lib/observability/wrapper";
import connectDb from "../../server/src/db/connectDb";
import Prompt from "../../server/src/models/Prompt";
import User from "../../server/src/models/User";

export interface CursorPayload {
  createdAt: string;
  id: string;
}

export interface DecodedCursor {
  createdAt: Date;
  id: mongoose.Types.ObjectId;
}

/**
 * Encodes a prompt document into a base64url cursor token.
 *
 * @param item - An object containing createdAt and _id or id
 * @returns A base64url encoded cursor string
 */
export function encodeCursor(item: { createdAt: Date | string; _id?: any; id?: any }): string {
  const createdAt =
    item.createdAt instanceof Date
      ? item.createdAt.toISOString()
      : new Date(item.createdAt).toISOString();
  const id = (item._id ?? item.id).toString();
  const payload: CursorPayload = { createdAt, id };
  const base64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodes and strictly validates a base64url cursor token.
 *
 * @param token - Base64url encoded cursor string
 * @returns Decoded cursor containing parsed Date and ObjectId
 * @throws Error if the token is invalid, tampered, or malformed
 */
export function decodeCursor(token: unknown): DecodedCursor {
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Cursor token must be a non-empty string");
  }

  let parsed: any;
  try {
    let base64 = token.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) {
      base64 += "=";
    }
    const jsonStr = Buffer.from(base64, "base64").toString("utf8");
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error("Invalid base64url or JSON format in cursor token");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Cursor payload must be an object");
  }

  if (!parsed.createdAt || typeof parsed.createdAt !== "string") {
    throw new Error("Cursor payload missing createdAt string");
  }

  const createdAt = new Date(parsed.createdAt);
  if (isNaN(createdAt.getTime())) {
    throw new Error("Cursor payload has invalid createdAt date");
  }

  if (
    !parsed.id ||
    typeof parsed.id !== "string" ||
    !mongoose.Types.ObjectId.isValid(parsed.id)
  ) {
    throw new Error("Cursor payload has invalid ObjectId");
  }

  return {
    createdAt,
    id: new mongoose.Types.ObjectId(parsed.id),
  };
}

/**
 * API handler for fetching prompts using deterministic cursor pagination under listing churn.
 *
 * @param req - HTTP request object
 * @param res - HTTP response object
 */
export async function handler(req: any, res: any) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await connectDb();

    const { category, walletAddress, cursor, limit } = req.query ?? {};

    let decodedCursor: DecodedCursor | null = null;
    if (cursor !== undefined && cursor !== null && String(cursor).trim() !== "") {
      try {
        decodedCursor = decodeCursor(String(cursor));
      } catch {
        res.status(400).json({ error: "Invalid cursor token" });
        return;
      }
    }

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
        res.status(200).json({
          items: [],
          prompts: [],
          nextCursor: null,
          hasMore: false,
        });
        return;
      }
      query.owner = user._id;
    }

    if (decodedCursor) {
      query.$or = [
        { createdAt: { $lt: decodedCursor.createdAt } },
        {
          createdAt: decodedCursor.createdAt,
          _id: { $lt: decodedCursor.id },
        },
      ];
    }

    const parsedLimit = parseInt(String(limit), 10);
    const pageSize =
      !isNaN(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 20;

    const rows = await Prompt.find(query)
      .populate("owner", "username walletAddress")
      .sort({ createdAt: -1, _id: -1 })
      .limit(pageSize + 1);

    const hasMore = rows.length > pageSize;
    const items = rows.slice(0, pageSize);
    const lastItem = items.length > 0 ? items[items.length - 1] : null;

    const nextCursor = hasMore && lastItem ? encodeCursor(lastItem) : null;

    res.status(200).json({
      items,
      prompts: items,
      nextCursor,
      hasMore,
    });
  } catch (error) {
    console.error("Fetch prompts error:", error);
    res.status(500).json({ error: "Failed to fetch prompts" });
  }
}

export default withObservability(handler, "prompts/index");
