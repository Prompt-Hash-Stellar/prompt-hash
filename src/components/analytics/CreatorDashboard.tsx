import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  Coins,
  Eye,
  PackageCheck,
  ShoppingBag,
  Trophy,
} from "lucide-react";
import { Skeleton } from "@/components/Skeleton";
import { Badge } from "@/components/ui/badge";
import { getAllPrompts, type PromptRecord } from "@/lib/stellar/promptHashClient";
import { browserStellarConfig } from "@/lib/stellar/browserConfig";
import { formatPriceLabel } from "@/lib/stellar/format";
import {
  calculateCreatorAnalytics,
  formatEstimatedGrossRevenue,
} from "@/lib/analytics/creatorAnalytics";

interface MetricCardProps {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  accent?: "emerald" | "cyan" | "amber" | "purple";
  description?: string;
  isLoading?: boolean;
}

function MetricCard({ title, value, icon, accent = "emerald", description, isLoading }: MetricCardProps) {
  const accentClasses: Record<string, string> = {
    emerald: "bg-emerald-500/10 text-emerald-300",
    cyan: "bg-cyan-500/10 text-cyan-300",
    amber: "bg-amber-500/10 text-amber-300",
    purple: "bg-purple-500/10 text-purple-300",
  };

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${accentClasses[accent]}`}>
            {icon}
          </div>
          <Skeleton className="h-3.5 w-24" />
        </div>
        <Skeleton className="h-8 w-16 mb-1.5" />
        {description && <Skeleton className="h-3 w-28" />}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 hover:bg-white/[0.06] transition-colors">
      <div className="flex items-center gap-3 mb-3">
        <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${accentClasses[accent]}`}>
          {icon}
        </div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          {title}
        </p>
      </div>
      <p className="text-3xl font-bold tabular-nums text-white">{value}</p>
      {description && (
        <p className="mt-1 text-xs text-slate-500">{description}</p>
      )}
    </div>
  );
}

interface TopPromptRowProps {
  rank: number;
  prompt: PromptRecord;
}

function TopPromptRow({ rank, prompt }: TopPromptRowProps) {
  const revenue = formatEstimatedGrossRevenue(
    prompt.priceStroops * BigInt(prompt.salesCount),
  );

  return (
    <Link
      to={`/prompts/${prompt.id.toString()}`}
      className="flex items-center gap-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 transition-colors hover:bg-white/[0.05]"
    >
      <span className="w-5 shrink-0 text-center text-sm font-bold text-slate-600">
        {rank}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-white">
          {prompt.title || "Untitled prompt"}
        </p>
        <p className="text-xs text-slate-500">{prompt.category || "Uncategorized"}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold text-white">{prompt.salesCount} sales</p>
        <p className="text-xs text-slate-500">{revenue} gross</p>
      </div>
      <Badge
        className={
          prompt.active
            ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
            : "border-slate-400/20 bg-slate-400/10 text-slate-400"
        }
      >
        {prompt.active ? "Active" : "Paused"}
      </Badge>
    </Link>
  );
}

interface CreatorDashboardProps {
  walletAddress: string;
}

export function CreatorDashboard({ walletAddress }: CreatorDashboardProps) {
  const { data: allPrompts = [], isLoading, isError } = useQuery({
    queryKey: ["creator-dashboard", walletAddress],
    queryFn: () => getAllPrompts(browserStellarConfig),
    staleTime: 30_000,
    enabled: Boolean(walletAddress),
  });

  const { data: previewStats } = useQuery({
    queryKey: ["preview-stats", walletAddress],
    queryFn: async () => {
      const res = await fetch(`/api/prompts/preview/stats?walletAddress=${encodeURIComponent(walletAddress)}`);
      if (!res.ok) return null;
      return res.json() as Promise<{ totalPreviews: number }>;
    },
    staleTime: 30_000,
    enabled: Boolean(walletAddress),
  });

  const prompts = useMemo(
    () => allPrompts.filter((p) => p.creator === walletAddress),
    [allPrompts, walletAddress],
  );

  const metrics = useMemo(() => calculateCreatorAnalytics(prompts), [prompts]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <MetricCard
              key={i}
              title="Loading"
              value="—"
              icon={<BarChart3 className="h-4 w-4" />}
              isLoading
            />
          ))}
        </div>
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl border border-white/5 bg-white/[0.02]" />
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-xl border border-rose-400/20 bg-rose-400/[0.05] p-6 text-center">
        <p className="text-sm font-medium text-rose-300">Failed to load creator metrics</p>
        <p className="mt-1 text-xs text-slate-400">Could not read listing data from the contract.</p>
      </div>
    );
  }

  if (prompts.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-white/15 bg-white/[0.02] p-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-400/10 text-amber-200">
          <BarChart3 className="h-6 w-6" />
        </div>
        <h3 className="mt-4 text-base font-semibold text-white">No listings yet</h3>
        <p className="mt-1.5 text-sm text-slate-400">
          Create your first encrypted prompt to start tracking performance, revenue, and sales.
        </p>
        <Link
          to="/sell"
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-amber-400/10 px-4 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-400/20 transition-colors"
        >
          <ShoppingBag className="h-4 w-4" />
          Create a listing
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Metric cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
        <MetricCard
          title="Active listings"
          value={metrics.activeListings}
          icon={<Activity className="h-4 w-4" />}
          accent="emerald"
          description="available to buyers"
        />
        <MetricCard
          title="Inactive listings"
          value={metrics.inactiveListings}
          icon={<ShoppingBag className="h-4 w-4" />}
          accent="purple"
          description="paused or archived"
        />
        <MetricCard
          title="Total sales"
          value={metrics.totalSales}
          icon={<PackageCheck className="h-4 w-4" />}
          accent="cyan"
          description="completed purchases"
        />
        <MetricCard
          title="Gross revenue"
          value={formatEstimatedGrossRevenue(metrics.estimatedGrossRevenueStroops)}
          icon={<Coins className="h-4 w-4" />}
          accent="amber"
          description="price × on-chain sales"
        />
        <MetricCard
          title="Preview opens"
          value={previewStats?.totalPreviews ?? 0}
          icon={<Eye className="h-4 w-4" />}
          accent="cyan"
          description="total preview views"
        />
      </div>

      {/* Top-performing prompts */}
      {metrics.topPrompts.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Trophy className="h-4 w-4 text-amber-400" />
            <h3 className="text-sm font-semibold uppercase tracking-widest text-slate-400">
              Top Performers
            </h3>
          </div>
          <div className="space-y-2">
            {metrics.topPrompts.map((prompt, i) => (
              <TopPromptRow key={prompt.id.toString()} rank={i + 1} prompt={prompt} />
            ))}
          </div>
        </div>
      )}

      {/* Pricing summary for all active listings */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-widest text-slate-400">
          All listings
        </h3>
        <div className="divide-y divide-white/[0.04] rounded-xl border border-white/[0.06] bg-white/[0.02]">
          {prompts.map((prompt) => (
            <div key={prompt.id.toString()} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <Link
                  to={`/prompts/${prompt.id.toString()}`}
                  className="truncate text-sm font-medium text-white hover:text-emerald-300"
                >
                  {prompt.title || "Untitled prompt"}
                </Link>
                <p className="text-xs text-slate-500">{prompt.category || "Uncategorized"}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-semibold text-white">{formatPriceLabel(prompt.priceStroops)}</p>
                <p className="text-xs text-slate-500">{prompt.salesCount} sold</p>
              </div>
              <Badge
                className={
                  prompt.active
                    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                    : "border-slate-400/20 bg-slate-400/10 text-slate-400"
                }
              >
                {prompt.active ? "Active" : "Paused"}
              </Badge>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
