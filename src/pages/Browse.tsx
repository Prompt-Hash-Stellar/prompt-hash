import { useState, useMemo } from "react";
import { useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { useAsyncTransaction } from "../components/useAsyncTransaction";
import { Skeleton } from "../components/Skeleton";

export interface BrowsePromptItem {
  id: string;
  name: string;
  price: string;
  isSold?: boolean;
}

export interface BrowsePageResponse {
  items: BrowsePromptItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Fetches a page of prompt listings using cursor-based pagination.
 *
 * @param cursor - Optional base64url cursor token for next page
 * @param limit - Page size limit
 * @returns Paginated browse prompt response
 */
export async function fetchBrowsePrompts(
  cursor: string | null = null,
  limit: number = 6,
): Promise<BrowsePageResponse> {
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
          })),
          nextCursor: data.nextCursor ?? null,
          hasMore: Boolean(data.hasMore),
        };
      }
    }
  } catch {
    return {
      items: [
        { id: "1", name: "AI Prompt #1", price: "10 XLM" },
        { id: "2", name: "AI Prompt #2", price: "20 XLM" },
        { id: "3", name: "AI Prompt #3", price: "50 XLM" },
      ],
      nextCursor: null,
      hasMore: false,
    };
  }

  return {
    items: [
      { id: "1", name: "AI Prompt #1", price: "10 XLM" },
      { id: "2", name: "AI Prompt #2", price: "20 XLM" },
      { id: "3", name: "AI Prompt #3", price: "50 XLM" },
    ],
    nextCursor: null,
    hasMore: false,
  };
}

/**
 * Executes a simulated Stellar contract call for prompt purchase.
 *
 * @param _itemId - Target prompt item identifier
 * @returns Promise resolving after simulated latency
 */
const purchasePrompt = async (_itemId: string): Promise<void> => {
  void _itemId;
  return new Promise((resolve) => setTimeout(resolve, 2000));
};

/**
 * Browse page supporting cursor-driven pagination and listing deduplication under churn.
 */
export default function Browse() {
  const queryClient = useQueryClient();
  const [optimisticPurchases, setOptimisticPurchases] = useState<Set<string>>(new Set());

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading: isFetching,
  } = useInfiniteQuery({
    queryKey: ["marketplace-items"],
    queryFn: ({ pageParam }) => fetchBrowsePrompts(pageParam, 6),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
  });

  const items = useMemo(() => {
    if (!data?.pages) return [];
    const seen = new Set<string>();
    const result: BrowsePromptItem[] = [];
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

  const { execute, isLoading: isPurchasing } = useAsyncTransaction(
    async (itemId: string) => {
      await purchasePrompt(itemId);
    },
    {
      pendingMessage: "Processing purchase on the Stellar network...",
      successMessage: "Purchase complete! Prompt unlocked.",
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
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6 text-white">Marketplace</h1>

      {isFetching ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((item) => {
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
                  <button
                    type="button"
                    onClick={() => execute(item.id)}
                    disabled={isProcessing}
                    className="mt-4 w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-600/50 disabled:cursor-not-allowed text-white font-bold rounded-md transition-colors cursor-pointer"
                  >
                    {isProcessing ? "Processing..." : "Purchase"}
                  </button>
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
                className="px-6 py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white font-medium rounded-lg border border-white/10 transition-colors cursor-pointer"
              >
                {isFetchingNextPage ? "Loading more..." : "Load More"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}