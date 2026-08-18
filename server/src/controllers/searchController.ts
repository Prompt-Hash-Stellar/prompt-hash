import Prompt from "../models/Prompt";
import {
  escapeRegex,
  SearchBudgetError,
  MAX_QUERY_LENGTH,
  MAX_SEARCH_LIMIT,
  MAX_SUGGESTION_LIMIT,
  MAX_SEARCH_TIME_MS,
  MAX_SUGGESTION_TIME_MS,
} from "../utils/searchUtils";

interface SearchFilters {
  query?: string;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  sortBy?: "recent" | "price-low" | "price-high" | "sales" | "rating";
  page?: number;
  limit?: number;
}

interface SearchResponse {
  prompts: any[];
  total: number;
  page: number;
  totalPages: number;
  hasMore: boolean;
}

/**
 * Search prompts with advanced filtering and pagination
 */
export async function searchPrompts(filters: SearchFilters): Promise<SearchResponse> {
  const {
    query = "",
    category,
    minPrice = 0,
    maxPrice = 1000000,
    sortBy = "recent",
  } = filters;

  const trimmedQuery = (query || "").trim();
  if (trimmedQuery.length > MAX_QUERY_LENGTH) {
    throw new SearchBudgetError(
      `Query length exceeds maximum limit of ${MAX_QUERY_LENGTH} characters`,
      "QUERY_LENGTH_EXCEEDED",
      400
    );
  }

  const limit = Math.max(1, Math.min(Number(filters.limit) || 20, MAX_SEARCH_LIMIT));
  const page = Math.max(1, Math.min(Number(filters.page) || 1, 1000));

  // Build the base query
  const baseQuery: any = {
    isActive: true,
    listingStatus: "published",
    price: { $gte: minPrice, $lte: maxPrice },
  };

  // Add category filter if specified
  if (category && category !== "") {
    baseQuery.category = category;
  }

  // Add text search if query is provided
  let searchQuery = Prompt.find(baseQuery);

  if (trimmedQuery !== "") {
    const escapedPattern = escapeRegex(trimmedQuery);
    const searchRegex = new RegExp(escapedPattern, "i");
    searchQuery = searchQuery.or([
      { title: searchRegex },
      { content: searchRegex },
      { category: searchRegex },
    ]);
  }

  // Apply sorting with deterministic tie-breaker
  let sortOptions: any;
  switch (sortBy) {
    case "price-low":
      sortOptions = { price: 1, _id: -1 };
      break;
    case "price-high":
      sortOptions = { price: -1, _id: -1 };
      break;
    case "sales":
      sortOptions = { salesCount: -1, _id: -1 };
      break;
    case "rating":
      sortOptions = { rating: -1, _id: -1 };
      break;
    case "recent":
    default:
      sortOptions = { createdAt: -1, _id: -1 };
      break;
  }

  try {
    const total = await Prompt.countDocuments(searchQuery.getFilter()).maxTimeMS(MAX_SEARCH_TIME_MS);

    const prompts = await searchQuery
      .sort(sortOptions)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("owner", "walletAddress username rating")
      .maxTimeMS(MAX_SEARCH_TIME_MS)
      .lean();

    const totalPages = Math.ceil(total / limit);
    const hasMore = page < totalPages;

    return {
      prompts,
      total,
      page,
      totalPages,
      hasMore,
    };
  } catch (error: any) {
    if (error instanceof SearchBudgetError) throw error;
    if (
      error.name === "MongoServerError" &&
      (error.code === 50 || error.message?.includes("time limit") || error.message?.includes("exceeded"))
    ) {
      throw new SearchBudgetError("Search query execution time budget exceeded", "QUERY_TIMEOUT_EXCEEDED", 408);
    }
    throw error;
  }
}

/**
 * Get search suggestions based on query
 */
export async function getSearchSuggestions(query: string, limit: number = 5) {
  const trimmedQuery = (query || "").trim();
  if (trimmedQuery.length > MAX_QUERY_LENGTH) {
    throw new SearchBudgetError(
      `Query length exceeds maximum limit of ${MAX_QUERY_LENGTH} characters`,
      "QUERY_LENGTH_EXCEEDED",
      400
    );
  }

  if (!trimmedQuery || trimmedQuery.length < 2) {
    return { titles: [], categories: [] };
  }

  const boundedLimit = Math.max(1, Math.min(Number(limit) || 5, MAX_SUGGESTION_LIMIT));
  const escapedPattern = escapeRegex(trimmedQuery);
  const searchRegex = new RegExp(escapedPattern, "i");

  try {
    const [titles, categories] = await Promise.all([
      Prompt.find({ title: searchRegex, isActive: true })
        .select("title")
        .limit(boundedLimit)
        .maxTimeMS(MAX_SUGGESTION_TIME_MS)
        .lean(),
      Prompt.distinct("category", { category: searchRegex, isActive: true }).then((cats: string[]) =>
        cats.slice(0, boundedLimit),
      ),
    ]);

    return {
      titles: titles.map((p: any) => p.title),
      categories,
    };
  } catch (error: any) {
    if (error instanceof SearchBudgetError) throw error;
    if (
      error.name === "MongoServerError" &&
      (error.code === 50 || error.message?.includes("time limit") || error.message?.includes("exceeded"))
    ) {
      throw new SearchBudgetError("Suggestion query execution time budget exceeded", "QUERY_TIMEOUT_EXCEEDED", 408);
    }
    throw error;
  }
}

/**
 * Get available categories with counts
 */
export async function getCategoriesWithCounts() {
  const categories = await Prompt.aggregate([
    { $match: { isActive: true, listingStatus: "published" } },
    { $group: { _id: "$category", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  return categories.map((cat: any) => ({
    name: cat._id,
    count: cat.count,
  }));
}

/**
 * Get featured/top prompts
 */
export async function getFeaturedPrompts(limit: number = 6) {
  const prompts = await Prompt.find({
    isActive: true,
    listingStatus: "published",
  })
    .sort({ salesCount: -1, rating: -1 })
    .limit(limit)
    .populate("owner", "walletAddress username rating")
    .lean();

  return prompts;
}

