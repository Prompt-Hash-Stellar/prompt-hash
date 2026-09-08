import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import Marketplace, {
  fetchMarketplacePrompts,
} from "@/pages/Marketplace";
import Browse, {
  fetchBrowsePrompts,
} from "@/pages/Browse";
import { renderWithProviders } from "@/test/render";

vi.mock("@/components/MarketplaceActivityFeed", () => ({
  MarketplaceActivityFeed: () => <div data-testid="mock-activity-feed">Activity Feed</div>,
}));

vi.mock("@/hooks/usePerformanceAudit", () => ({
  usePerformanceAudit: () => ({ markDone: vi.fn() }),
}));

/**
 * Creates a mock fetch response with JSON payload.
 *
 * @param payload - Response data
 * @param ok - Success status
 * @returns Mock Response object
 */
function createFetchResponse(payload: any, ok: boolean = true) {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(payload),
  } as Response);
}

describe("marketplace cursor pagination and listing churn UI integration (#243)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("fetchMarketplacePrompts and fetchBrowsePrompts API client", () => {
    it("requests with cursor and limit query parameters", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        createFetchResponse({
          items: [
            {
              _id: "607f1f77bcf86cd799439001",
              title: "Prompt Alpha",
              price: 15,
              listingStatus: "published",
              isActive: true,
            },
          ],
          nextCursor: "test-next-cursor",
          hasMore: true,
        }),
      );

      const result = await fetchMarketplacePrompts("cursor-token-xyz", 6);

      expect(fetchSpy).toHaveBeenCalledWith("/api/prompts?cursor=cursor-token-xyz&limit=6");
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe("607f1f77bcf86cd799439001");
      expect(result.items[0].name).toBe("Prompt Alpha");
      expect(result.items[0].price).toBe("15 XLM");
      expect(result.items[0].isSold).toBe(false);
      expect(result.nextCursor).toBe("test-next-cursor");
      expect(result.hasMore).toBe(true);
    });

    it("falls back gracefully when fetch encounters network error", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disconnect"));

      const result = await fetchMarketplacePrompts(null, 6);
      expect(result.items).toHaveLength(3);
      expect(result.hasMore).toBe(false);
    });

    it("fetches browse prompts with cursor query parameter", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        createFetchResponse({
          items: [
            {
              _id: "607f1f77bcf86cd799439002",
              title: "Browse Prompt #1",
              price: 25,
            },
          ],
          nextCursor: null,
          hasMore: false,
        }),
      );

      const result = await fetchBrowsePrompts("cursor-page-2", 10);

      expect(fetchSpy).toHaveBeenCalledWith("/api/prompts?cursor=cursor-page-2&limit=10");
      expect(result.items[0].name).toBe("Browse Prompt #1");
      expect(result.hasMore).toBe(false);
    });
  });

  describe("Marketplace component pagination and churn resilience", () => {
    it("renders page 1 and loads page 2 upon clicking load more", async () => {
      const user = userEvent.setup();

      vi.spyOn(globalThis, "fetch").mockImplementation((url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes("cursor=cursor-token-page-1")) {
          return createFetchResponse({
            items: [
              {
                _id: "item-page-2",
                title: "Page 2 Prompt Item",
                price: "30 XLM",
                listingStatus: "published",
                isActive: true,
              },
            ],
            nextCursor: null,
            hasMore: false,
          });
        }

        return createFetchResponse({
          items: [
            {
              _id: "item-page-1",
              title: "Page 1 Prompt Item",
              price: "10 XLM",
              listingStatus: "published",
              isActive: true,
            },
          ],
          nextCursor: "cursor-token-page-1",
          hasMore: true,
        });
      });

      renderWithProviders(<Marketplace />);

      expect(await screen.findByText("Page 1 Prompt Item")).toBeInTheDocument();

      const loadMoreButton = await screen.findByRole("button", {
        name: /load more prompts/i,
      });
      expect(loadMoreButton).toBeInTheDocument();

      await user.click(loadMoreButton);

      expect(await screen.findByText("Page 2 Prompt Item")).toBeInTheDocument();
      expect(screen.getByText("Page 1 Prompt Item")).toBeInTheDocument();
    });

    it("deduplicates items across pages under listing churn", async () => {
      const user = userEvent.setup();

      vi.spyOn(globalThis, "fetch").mockImplementation((url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes("cursor=cursor-churn")) {
          return createFetchResponse({
            items: [
              {
                _id: "duplicate-id-1",
                title: "Page 1 Prompt Duplicate From Churn",
                price: "10 XLM",
                listingStatus: "published",
                isActive: true,
              },
              {
                _id: "unique-id-2",
                title: "Page 2 Fresh Unique Prompt",
                price: "45 XLM",
                listingStatus: "published",
                isActive: true,
              },
            ],
            nextCursor: null,
            hasMore: false,
          });
        }

        return createFetchResponse({
          items: [
            {
              _id: "duplicate-id-1",
              title: "Page 1 Prompt Duplicate From Churn",
              price: "10 XLM",
              listingStatus: "published",
              isActive: true,
            },
          ],
          nextCursor: "cursor-churn",
          hasMore: true,
        });
      });

      renderWithProviders(<Marketplace />);

      expect(
        await screen.findByText("Page 1 Prompt Duplicate From Churn"),
      ).toBeInTheDocument();

      const loadMoreButton = await screen.findByRole("button", {
        name: /load more prompts/i,
      });
      await user.click(loadMoreButton);

      expect(await screen.findByText("Page 2 Fresh Unique Prompt")).toBeInTheDocument();

      const duplicateElements = screen.getAllByText(
        "Page 1 Prompt Duplicate From Churn",
      );
      expect(duplicateElements).toHaveLength(1);
    });

    it("renders owned badge when a prompt is marked sold", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        createFetchResponse({
          items: [
            {
              _id: "sold-prompt-id",
              title: "Exclusive Sold Prompt",
              price: "100 XLM",
              isSold: true,
            },
          ],
          nextCursor: null,
          hasMore: false,
        }),
      );

      renderWithProviders(<Marketplace />);

      expect(await screen.findByText("Exclusive Sold Prompt")).toBeInTheDocument();
      expect(screen.getByText("Owned")).toBeInTheDocument();
    });

    it("renders empty state when no listings exist", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        createFetchResponse({
          items: [],
          nextCursor: null,
          hasMore: false,
        }),
      );

      renderWithProviders(<Marketplace />);

      expect(
        await screen.findByText("No prompts listed yet"),
      ).toBeInTheDocument();
    });
  });

  describe("Browse component pagination and churn resilience", () => {
    it("renders browse items and loads more pages with cursor", async () => {
      const user = userEvent.setup();

      vi.spyOn(globalThis, "fetch").mockImplementation((url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes("cursor=browse-page-1-cursor")) {
          return createFetchResponse({
            items: [
              {
                _id: "browse-item-2",
                title: "Browse Next Prompt",
                price: 20,
              },
            ],
            nextCursor: null,
            hasMore: false,
          });
        }

        return createFetchResponse({
          items: [
            {
              _id: "browse-item-1",
              title: "Browse Initial Prompt",
              price: 10,
            },
          ],
          nextCursor: "browse-page-1-cursor",
          hasMore: true,
        });
      });

      renderWithProviders(<Browse />);

      expect(await screen.findByText("Browse Initial Prompt")).toBeInTheDocument();

      const loadMoreButton = await screen.findByRole("button", {
        name: /load more/i,
      });
      await user.click(loadMoreButton);

      expect(await screen.findByText("Browse Next Prompt")).toBeInTheDocument();
    });
  });
});
