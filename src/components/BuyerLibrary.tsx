import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { RefundRequestModal } from "./RefundRequestModal";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpenCheck,
  CheckCircle2,
  Clock,
  Eye,
  FilterX,
  History,
  Loader2,
  LockKeyhole,
  PlugZap,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  Trash2,
  WifiOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWallet } from "@/hooks/useWallet";
import { browserStellarConfig } from "@/lib/stellar/browserConfig";
import { getPromptsByBuyer, type PromptRecord } from "@/lib/stellar/promptHashClient";
import { formatPriceLabel } from "@/lib/stellar/format";
import { unlockPromptContent } from "@/lib/prompts/unlock";
import { UnlockExplainer, type UnlockState } from "@/components/UnlockExplainer";
import { stellarNetwork } from "@/lib/env";
import {
  addUnlockHistoryEntry,
  clearUnlockHistory,
  filterLibraryPrompts,
  getUnlockHistory,
  type SortOption,
  type StatusFilter,
} from "@/lib/prompts/librarySearch";

const EXPECTED_NETWORK = stellarNetwork;

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "unlocked", label: "Unlocked" },
  { value: "locked", label: "Locked" },
];

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "price-high", label: "Price: high to low" },
  { value: "price-low", label: "Price: low to high" },
];

const FILTER_DEFAULTS = {
  category: "all",
  status: "all" as StatusFilter,
  sort: "newest" as SortOption,
};

const ALL_CATEGORIES = "all";

function coerceStatus(value: string | null): StatusFilter {
  return STATUS_OPTIONS.some((o) => o.value === value)
    ? (value as StatusFilter)
    : FILTER_DEFAULTS.status;
}

function coerceSort(value: string | null): SortOption {
  return SORT_OPTIONS.some((o) => o.value === value)
    ? (value as SortOption)
    : FILTER_DEFAULTS.sort;
}

function EmptyLibrary() {
  return (
    <div className="grid min-h-64 place-items-center rounded-xl border border-dashed border-white/15 bg-white/[0.02] p-8 text-center">
      <div className="max-w-xs">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-cyan-200/10 text-cyan-100">
          <BookOpenCheck className="h-7 w-7" />
        </div>
        <h3 className="mt-4 text-lg font-semibold text-white">No purchases yet</h3>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          Prompts you purchase will appear here with a direct unlock path to the
          decrypted content.
        </p>
        <Button asChild className="mt-5 h-9 bg-cyan-200 text-slate-950 hover:bg-cyan-100 px-5">
          <Link to="/browse">
            <ShoppingBag className="h-4 w-4" />
            Browse marketplace
          </Link>
        </Button>
      </div>
    </div>
  );
}

function DisconnectedState() {
  return (
    <div className="grid min-h-64 place-items-center rounded-xl border border-white/10 bg-white/[0.02] p-8 text-center">
      <div className="max-w-xs">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-700/50 text-slate-400">
          <PlugZap className="h-7 w-7" />
        </div>
        <h3 className="mt-4 text-lg font-semibold text-white">Wallet not connected</h3>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          Connect your Stellar wallet to view prompts you have purchased.
        </p>
      </div>
    </div>
  );
}

function WrongNetworkState({ network }: { network?: string }) {
  return (
    <div className="grid min-h-64 place-items-center rounded-xl border border-amber-300/20 bg-amber-300/[0.04] p-8 text-center">
      <div className="max-w-xs">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-300/10 text-amber-200">
          <WifiOff className="h-7 w-7" />
        </div>
        <h3 className="mt-4 text-lg font-semibold text-white">Wrong network</h3>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          You are connected to{" "}
          <span className="font-semibold text-amber-200">{network ?? "an unknown network"}</span>.
          Switch to{" "}
          <span className="font-semibold text-white">{EXPECTED_NETWORK}</span> to
          view your library.
        </p>
      </div>
    </div>
  );
}

function PromptLibraryCard({
  prompt,
  plaintext,
  unlockState,
  isBusy,
  onUnlock,
  buyerWallet,
}: {
  prompt: PromptRecord;
  plaintext?: string;
  unlockState: UnlockState;
  isBusy: boolean;
  onUnlock: () => void;
  buyerWallet?: string;
}) {
  const isUnlocked = Boolean(plaintext);
  const showExplainer = unlockState !== "idle" && unlockState !== "success";
  const [showRefundModal, setShowRefundModal] = useState(false);
  const canRequestRefund = unlockState === "failed" && buyerWallet;

  return (
    <article className="overflow-hidden rounded-xl border border-white/10 bg-[#0f1419] transition-colors hover:border-white/[0.18]">
      <div className="p-5 space-y-4">
        {/* Header row */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap gap-2 mb-2">
              <Badge className="border-cyan-200/30 bg-cyan-200/10 text-cyan-100">
                <BookOpenCheck className="mr-1 h-3 w-3" />
                License owned
              </Badge>
              <Badge className="border-white/10 bg-white/[0.04] text-slate-300">
                {prompt.category}
              </Badge>
              <Badge
                className={
                  isUnlocked
                    ? "border-emerald-300/30 bg-emerald-300/10 text-emerald-100"
                    : "border-amber-300/30 bg-amber-300/10 text-amber-100"
                }
              >
                {isUnlocked ? (
                  <Eye className="mr-1 h-3 w-3" />
                ) : (
                  <LockKeyhole className="mr-1 h-3 w-3" />
                )}
                {isUnlocked ? "Unlocked" : "Locked"}
              </Badge>
            </div>
            <h3 className="text-base font-semibold text-white leading-snug">
              {prompt.title}
            </h3>
            <p className="mt-1 text-xs leading-5 text-slate-500 line-clamp-2">
              {prompt.previewText}
            </p>
          </div>
          <div className="shrink-0 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-right">
            <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
              Paid
            </p>
            <p className="mt-0.5 text-sm font-semibold text-white">
              {formatPriceLabel(prompt.priceStroops)}
            </p>
          </div>
        </div>

        {/* Unlock explainer — shown for non-idle, non-success states */}
        {showExplainer && (
          <UnlockExplainer
            state={unlockState}
            onRetry={
              unlockState === "rejected" ||
              unlockState === "expired" ||
              unlockState === "failed"
                ? onUnlock
                : undefined
            }
          />
        )}

        {/* Unlocked content */}
        {isUnlocked && (
          <div className="rounded-xl border border-emerald-300/20 bg-emerald-300/[0.07] p-4">
            <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-200">
              <ShieldCheck className="h-3.5 w-3.5" />
              Decrypted content
            </div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs leading-6 text-slate-200">
              {plaintext}
            </pre>
          </div>
        )}

        {/* Action button */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            className="h-9 bg-cyan-200 text-slate-950 hover:bg-cyan-100 disabled:opacity-50 text-xs font-bold"
            onClick={onUnlock}
            disabled={isBusy || unlockState === "signing" || unlockState === "verifying"}
          >
            {isBusy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Unlocking…
              </>
            ) : isUnlocked ? (
              <>
                <Eye className="h-3.5 w-3.5" />
                Re-open prompt
              </>
            ) : (
              <>
                <LockKeyhole className="h-3.5 w-3.5" />
                Unlock full prompt
              </>
            )}
          </Button>
          {canRequestRefund && (
            <Button
              variant="outline"
              size="sm"
              className="h-9 border-amber-400/30 text-amber-300 hover:bg-amber-400/10 text-xs font-bold"
              onClick={() => setShowRefundModal(true)}
            >
              Request Refund
            </Button>
          )}
        </div>
      </div>
      {canRequestRefund && (
        <RefundRequestModal
          isOpen={showRefundModal}
          onClose={() => setShowRefundModal(false)}
          promptId={prompt.id.toString()}
          buyerWallet={buyerWallet!}
        />
      )}
    </article>
  );
}

export function BuyerLibrary() {
  const { address, network, signMessage } = useWallet();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState<Record<string, string>>({});
  const [unlockStates, setUnlockStates] = useState<Record<string, UnlockState>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);

  // Filter + sort state is mirrored in the URL
  const [searchParams, setSearchParams] = useSearchParams();
  const categoryFilter = searchParams.get("category") ?? FILTER_DEFAULTS.category;
  const statusFilter = coerceStatus(searchParams.get("status"));
  const sortOption = coerceSort(searchParams.get("sort"));

  const updateFilter = (key: string, value: string, defaultValue: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === defaultValue) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  };

  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    categoryFilter !== FILTER_DEFAULTS.category ||
    statusFilter !== FILTER_DEFAULTS.status ||
    sortOption !== FILTER_DEFAULTS.sort;

  const isWrongNetwork =
    Boolean(address) &&
    Boolean(network) &&
    network?.toLowerCase() !== EXPECTED_NETWORK.toLowerCase();

  const { data: prompts = [], isLoading, isError, refetch } = useQuery({
    queryKey: ["buyer-library", address],
    queryFn: () =>
      address ? getPromptsByBuyer(browserStellarConfig, address) : [],
    enabled: Boolean(address) && !isWrongNetwork,
  });

  const categories = useMemo(
    () =>
      Array.from(
        new Set(prompts.map((prompt) => prompt.category).filter(Boolean)),
      ).sort((a, b) => a.localeCompare(b)),
    [prompts],
  );

  const visiblePrompts = useMemo(() => {
    return filterLibraryPrompts(
      prompts,
      searchQuery,
      categoryFilter,
      statusFilter,
      sortOption,
      unlocked,
    );
  }, [prompts, searchQuery, categoryFilter, statusFilter, sortOption, unlocked]);

  const unlockHistory = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    historyVersion; // dependency to trigger refresh on history updates
    return getUnlockHistory(address ?? undefined);
  }, [address, historyVersion]);

  const setUnlockState = (id: string, state: UnlockState) =>
    setUnlockStates((prev) => ({ ...prev, [id]: state }));

  const handleUnlock = async (prompt: PromptRecord) => {
    if (!address || !signMessage) return;
    const id = prompt.id.toString();
    setBusyId(id);
    setUnlockState(id, "signing");

    try {
      const result = await unlockPromptContent(address, id, signMessage);
      setUnlockState(id, "success");
      setUnlocked((prev) => ({ ...prev, [id]: result.plaintext }));
      addUnlockHistoryEntry(address, {
        promptId: id,
        title: prompt.title,
        status: "success",
      });
      setHistoryVersion((v) => v + 1);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      let statusResult: "rejected" | "expired" | "failed" = "failed";
      if (msg.toLowerCase().includes("declined") || msg.toLowerCase().includes("rejected")) {
        statusResult = "rejected";
        setUnlockState(id, "rejected");
      } else if (msg.toLowerCase().includes("expired")) {
        statusResult = "expired";
        setUnlockState(id, "expired");
      } else {
        setUnlockState(id, "failed");
      }

      addUnlockHistoryEntry(address, {
        promptId: id,
        title: prompt.title,
        status: statusResult,
      });
      setHistoryVersion((v) => v + 1);
    } finally {
      setBusyId(null);
    }
  };

  const handleClearHistory = () => {
    if (address) {
      clearUnlockHistory(address);
      setHistoryVersion((v) => v + 1);
    }
  };

  if (!address) return <DisconnectedState />;
  if (isWrongNetwork) return <WrongNetworkState network={network} />;

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            className="h-32 rounded-xl border border-white/5 bg-white/[0.02] animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-rose-400/20 bg-rose-400/[0.05] p-8 text-center gap-3">
        <p className="text-sm font-medium text-rose-300">Failed to load library</p>
        <p className="text-xs text-slate-400">
          Could not read purchased prompts from the contract.
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void refetch()}
          className="border border-white/10 text-slate-300 hover:bg-white/10 text-xs"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (prompts.length === 0) return <EmptyLibrary />;

  return (
    <div className="space-y-5">
      {/* Search Bar & Toolbar */}
      <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center justify-between">
          {/* Search Input */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search library by title, category, or creator..."
              className="h-9 w-full rounded-md border border-white/10 bg-slate-950/60 pl-9 pr-3 text-xs text-white placeholder:text-slate-500 focus:border-cyan-200/50 focus:outline-none"
            />
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowHistoryDrawer(!showHistoryDrawer)}
            className="h-9 gap-1.5 border-white/10 text-slate-300 hover:bg-white/10 text-xs shrink-0"
          >
            <History className="h-3.5 w-3.5" />
            Unlock History ({unlockHistory.length})
          </Button>
        </div>

        {/* Filter + sort toolbar */}
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end pt-1">
          <div className="flex-1 space-y-1.5">
            <label className="text-[10px] font-medium uppercase tracking-[0.14em] text-slate-500">
              Category
            </label>
            <Select
              value={categoryFilter}
              onValueChange={(value) =>
                updateFilter("category", value, FILTER_DEFAULTS.category)
              }
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category} value={category}>
                    {category}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex-1 space-y-1.5">
            <label className="text-[10px] font-medium uppercase tracking-[0.14em] text-slate-500">
              Status
            </label>
            <Select
              value={statusFilter}
              onValueChange={(value) =>
                updateFilter("status", value, FILTER_DEFAULTS.status)
              }
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex-1 space-y-1.5">
            <label className="text-[10px] font-medium uppercase tracking-[0.14em] text-slate-500">
              Sort by
            </label>
            <Select
              value={sortOption}
              onValueChange={(value) =>
                updateFilter("sort", value, FILTER_DEFAULTS.sort)
              }
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearchQuery("");
                setSearchParams({}, { replace: true });
              }}
              className="h-9 shrink-0 border border-white/10 text-slate-300 hover:bg-white/10"
            >
              <FilterX className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Unlock History Drawer */}
      {showHistoryDrawer && (
        <div className="rounded-xl border border-cyan-200/20 bg-slate-950/80 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-cyan-200 flex items-center gap-1.5">
              <History className="h-4 w-4" /> Local Unlock Telemetry History
            </h4>
            {unlockHistory.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearHistory}
                className="h-7 text-[11px] text-slate-400 hover:text-rose-400 gap-1"
              >
                <Trash2 className="h-3 w-3" /> Clear History
              </Button>
            )}
          </div>

          {unlockHistory.length === 0 ? (
            <p className="text-xs text-slate-500 py-2">No recent unlock attempts recorded for this wallet.</p>
          ) : (
            <div className="max-h-48 overflow-y-auto space-y-2 pr-1">
              {unlockHistory.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between text-xs p-2 rounded-lg border border-white/5 bg-white/[0.02]"
                >
                  <div className="flex items-center gap-2 truncate">
                    {item.status === "success" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                    ) : (
                      <ShieldAlert className="h-3.5 w-3.5 text-rose-400 shrink-0" />
                    )}
                    <span className="text-slate-200 truncate">{item.title}</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 text-slate-500 text-[11px]">
                    <span className="capitalize">{item.status}</span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-slate-500">
        Showing {visiblePrompts.length} of {prompts.length}{" "}
        {prompts.length === 1 ? "prompt" : "prompts"}
      </p>

      {visiblePrompts.length === 0 ? (
        <div className="grid min-h-48 place-items-center rounded-xl border border-dashed border-white/15 bg-white/[0.02] p-8 text-center">
          <div className="max-w-xs">
            <h3 className="text-base font-semibold text-white">
              No prompts match search or filters
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              Try a different query, category, or status, or clear the filters to see
              everything in your library.
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearchQuery("");
                setSearchParams({}, { replace: true });
              }}
              className="mt-4 border border-white/10 text-slate-300 hover:bg-white/10"
            >
              <FilterX className="h-3.5 w-3.5" />
              Clear search & filters
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {visiblePrompts.map((prompt) => {
            const id = prompt.id.toString();
            return (
              <PromptLibraryCard
                key={id}
                prompt={prompt}
                plaintext={unlocked[id]}
                unlockState={unlockStates[id] ?? "idle"}
                isBusy={busyId === id}
                onUnlock={() => void handleUnlock(prompt)}
                buyerWallet={address ?? undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
