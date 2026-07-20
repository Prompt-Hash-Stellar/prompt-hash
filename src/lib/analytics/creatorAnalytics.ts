import type { PromptRecord } from "@/lib/stellar/promptHashClient";
import { formatPriceLabel } from "@/lib/stellar/format";

export interface CreatorAnalytics {
  activeListings: number;
  inactiveListings: number;
  totalSales: number;
  estimatedGrossRevenueStroops: bigint;
  topPrompts: PromptRecord[];
}

export function calculateCreatorAnalytics(
  prompts: PromptRecord[],
  topPromptLimit = 5,
): CreatorAnalytics {
  return {
    activeListings: prompts.filter((prompt) => prompt.active).length,
    inactiveListings: prompts.filter((prompt) => !prompt.active).length,
    totalSales: prompts.reduce((total, prompt) => total + prompt.salesCount, 0),
    estimatedGrossRevenueStroops: prompts.reduce(
      (total, prompt) => total + prompt.priceStroops * BigInt(prompt.salesCount),
      0n,
    ),
    topPrompts: [...prompts]
      .sort((left, right) => {
        if (right.salesCount !== left.salesCount) {
          return right.salesCount - left.salesCount;
        }
        return Number(left.id - right.id);
      })
      .slice(0, topPromptLimit),
  };
}

export function formatEstimatedGrossRevenue(stroops: bigint): string {
  return `Estimated ${formatPriceLabel(stroops)}`;
}
