import { useEffect, useState, useMemo } from "react";
import { useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { useAsyncTransaction } from "../components/useAsyncTransaction";
import { Skeleton } from "../components/Skeleton";
import { usePerformanceAudit } from "@/hooks/usePerformanceAudit";
import { MarketplaceActivityFeed } from "@/components/MarketplaceActivityFeed";

export interface MarketplaceItem {
  id: string;
  name: string;
  price: string;
  isSold: boolean;
  createdAt?: string;
}

export interface MarketplacePageResponse {
  items: MarketplaceItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Fetches a page of marketplace prompts using cursor-based pagination.
 *
 * @param cursor - Optional base64url cursor token for next page
 * @param limit - Page size limit
 * @returns Paginated marketplace prompt response
 */
export async function fetchMarketplacePrompts(
  cursor: string | null = null,
  limit: number = 6,
): Promise<MarketplacePageResponse> {
  const params = new URLSearchParams();
  if (cursor) {
    params.set("cursor", cursor);
  }
  params.set("limit", String(limit));

  try {
    const res = await fetch(`/api/prompts?${params.toString()}`);
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.items)) {
        return {
          items: data.items.map((prompt: any) => ({
            id: String(prompt._id ?? prompt.id),
            name: prompt.title ?? prompt.name ?? "Untitled Prompt",
            price:
              typeof prompt.price === "number"
                ? `${prompt.price} XLM`
                : String(prompt.price || "0 XLM"),
            isSold: Boolean(
              prompt.isSold ||
                prompt.listingStatus === "archived" ||
                !prompt.isActive,
            ),
            createdAt: prompt.createdAt ? String(prompt.createdAt) : undefined,
          })),
          nextCursor: data.nextCursor ?? null,
          hasMore: Boolean(data.hasMore),
        };
      }
    }
  } catch {
    return {
      items: [
        { id: "1", name: "AI Prompt #1", price: "10 XLM", isSold: false },
        { id: "2", name: "AI Prompt #2", price: "20 XLM", isSold: false },
        { id: "3", name: "AI Prompt #3", price: "50 XLM", isSold: true },
      ],
      nextCursor: null,
      hasMore: false,
    };
  }

  return {
    items: [
      { id: "1", name: "AI Prompt #1", price: "10 XLM", isSold: false },
      { id: "2", name: "AI Prompt #2", price: "20 XLM", isSold: false },
      { id: "3", name: "AI Prompt #3", price: "50 XLM", isSold: true },
    ],
    nextCursor: null,
    hasMore: false,
  };
}

/**
 * Executes a simulated Stellar Soroban contract call to purchase an asset.
 *
 * @param _itemId - Target prompt item identifier
 * @returns Promise resolving to boolean upon confirmation
 */
const buyAssetContractCall = async (_itemId: string): Promise<boolean> => {
  void _itemId;
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (Math.random() < 0.2) return reject(new Error("op_underfunded"));
      resolve(true);
    }, 2000);
  });
};

/**
 * Placeholder card rendered during initial data fetch.
 */
function MarketplaceSkeletonCard() {
  return (
    <div className="p-4 border border-white/10 rounded-xl bg-slate-900 shadow-sm flex flex-col justify-between animate-pulse">
      <div className="space-y-2">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-1/3" />
      </div>
      <div className="mt-4">
        <Skeleton className="h-10 w-full rounded-md" />
      </div>
    </div>
  );
}

/**
 * Empty-state guidance displayed when no prompts are listed in the marketplace.
 */
function MarketplaceEmptyState() {
  return (
    <div className="col-span-full flex flex-col items-center justify-center py-20 text-center">
      <div className="text-5xl mb-4" aria-hidden>🛒</div>
      <h2 className="text-xl font-semibold text-white mb-2">No prompts listed yet</h2>
      <p className="text-slate-400 max-w-sm">
        Be the first to list a prompt! Head to the{" "}
        <a href="/sell" className="text-purple-400 hover:text-purple-300 underline">
          Sell
        </a>{" "}
        page to publish your AI prompt and start earning XLM.
      </p>
    </div>
  );
}

/**
 * Marketplace view supporting stable cursor-based pagination under listing churn.
 */
export default function Marketplace() {
  const queryClient = useQueryClient();
  const [optimisticPurchases, setOptimisticPurchases] = useState<Set<string>>(new Set());

  const { markDone: markLoadDone } = usePerformanceAudit({ scope: "marketplace_load" });

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading: isFetching,
    isError,
  } = useInfiniteQuery({
    queryKey: ["marketplace-items"],
    queryFn: ({ pageParam }) => fetchMarketplacePrompts(pageParam, 6),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
  });

  const items = useMemo(() => {
    if (!data?.pages) return [];
    const seen = new Set<string>();
    const result: MarketplaceItem[] = [];
    for (const page of data.pages) {
      for (const item of page.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          result.push(item);
        }
      }
    }
    return result;
  }, [data]);

  useEffect(() => {
    if (!isFetching && !isError) {
      markLoadDone({ item_count: items.length });
    }
  }, [isFetching, isError, items.length, markLoadDone]);

  const { execute, isLoading: isPurchasing } = useAsyncTransaction(
    async (itemId: string) => {
      await buyAssetContractCall(itemId);
    },
    {
      pendingMessage: "Processing purchase on the Stellar network...",
      successMessage: "Purchase complete! Item unlocked.",
      onOptimistic: (itemId) => {
        setOptimisticPurchases((prev) => new Set(prev).add(itemId));
      },
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["account-balance"] });
        queryClient.invalidateQueries({ queryKey: ["marketplace-items"] });
      },
      onSettled: () => {
        setOptimisticPurchases(new Set());
      },
    }
  );

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Marketplace</h1>
          <p className="text-slate-400 text-sm mt-1">
            Browse and unlock AI prompts. Purchases are settled on the Stellar network.
          </p>
        </div>
        {!isFetching && !isError && (
          <span className="text-xs text-slate-500 tabular-nums">
            {items.length} listing{items.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {isError && (
        <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-6 text-center">
          <p className="text-red-400 font-medium">Failed to load marketplace listings.</p>
          <p className="text-slate-400 text-sm mt-1">Check your connection and refresh the page.</p>
        </div>
      )}

      <div className="flex flex-col xl:flex-row gap-8">
        <div className="flex-1 min-w-0">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {isFetching
              ? Array.from({ length: 6 }).map((_, i) => <MarketplaceSkeletonCard key={i} />)
              : items.length === 0
                ? <MarketplaceEmptyState />
                : items.map((item) => {
                    const isProcessing =
                      optimisticPurchases.has(item.id) ||
                      (isPurchasing && optimisticPurchases.has(item.id));
                    return (
                      <div
                        key={item.id}
                        className="p-4 border border-white/10 rounded-xl bg-slate-900 shadow-sm flex flex-col justify-between"
                      >
                        <div>
                          <h3 className="text-lg font-bold text-white">{item.name}</h3>
                          <p className="text-slate-400">{item.price}</p>
                        </div>
                        <div className="mt-4">
                          {item.isSold ? (
                            <span className="inline-block w-full text-center px-4 py-2 text-emerald-400 font-bold bg-emerald-950/30 rounded-md border border-emerald-900/50">
                              Owned
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => execute(item.id)}
                              disabled={isProcessing}
                              className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-600/50 disabled:cursor-not-allowed text-white font-bold rounded-md transition-colors"
                            >
                              {isProcessing ? (
                                <span className="flex items-center justify-center gap-2">
                                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                                  </svg>
                                  Purchasing…
                                </span>
                              ) : (
                                "Buy"
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
          </div>

          {hasNextPage && (
            <div className="mt-8 flex justify-center">
              <button
                type="button"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                className="px-6 py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white font-medium rounded-lg border border-white/10 transition-colors flex items-center gap-2 cursor-pointer"
              >
                {isFetchingNextPage ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    Loading more prompts...
                  </>
                ) : (
                  "Load More Prompts"
                )}
              </button>
            </div>
          )}

          {isPurchasing && (
            <p className="mt-6 text-center text-sm text-slate-400 animate-pulse">
              Waiting for Stellar network confirmation…
            </p>
          )}
        </div>

        <div className="xl:w-80 shrink-0">
          <MarketplaceActivityFeed className="sticky top-6" />
        </div>
      </div>
    </div>
  );
}
