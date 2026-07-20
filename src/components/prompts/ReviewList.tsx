import { useState } from "react";
import { StarRating } from "./StarRating";
import { User, Flag, CheckCircle2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReviewClient } from "@/lib/reviews/reviewClient";
import { useWallet } from "@/hooks/useWallet";

// Simple date formatting utility
const formatDistanceToNow = (date: Date, options?: { addSuffix?: boolean }) => {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  const suffix = options?.addSuffix ? " ago" : "";

  if (years > 0) return `${years} year${years > 1 ? "s" : ""}${suffix}`;
  if (months > 0) return `${months} month${months > 1 ? "s" : ""}${suffix}`;
  if (days > 0) return `${days} day${days > 1 ? "s" : ""}${suffix}`;
  if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""}${suffix}`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""}${suffix}`;
  return `${seconds} second${seconds !== 1 ? "s" : ""}${suffix}`;
};

export interface Review {
  id: string;
  promptId: string;
  userAddress: string;
  rating: number;
  text: string;
  createdAt: number;
  verified: boolean;
  status?: "visible" | "hidden" | "flagged" | "pending";
}

interface ReviewListProps {
  reviews: Review[];
  isLoading?: boolean;
  onReviewReported?: () => void;
}

const formatAddress = (address: string) => {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

const formatDate = (timestamp: number) => {
  try {
    return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
  } catch {
    return "Recently";
  }
};

export const ReviewList = ({ reviews, isLoading, onReviewReported }: ReviewListProps) => {
  const { address: currentWallet } = useWallet();
  const [reportingId, setReportingId] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState<string>("");
  const [reportSuccessId, setReportSuccessId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleReportSubmit = async (review: Review) => {
    if (!currentWallet) {
      setErrorMsg("Please connect your wallet to report a review.");
      return;
    }
    if (reportReason.trim().length < 5) {
      setErrorMsg("Please provide a reason (at least 5 characters).");
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      await ReviewClient.reportReview(review.id, review.promptId, currentWallet, reportReason);
      setReportSuccessId(review.id);
      setReportingId(null);
      setReportReason("");
      if (onReviewReported) {
        onReviewReported();
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to report review");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="p-4 rounded-2xl bg-white/5 border border-white/5 animate-pulse"
          >
            <div className="h-4 w-32 bg-white/10 rounded mb-3" />
            <div className="h-3 w-full bg-white/10 rounded mb-2" />
            <div className="h-3 w-2/3 bg-white/10 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (reviews.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-slate-800 mb-4">
          <User className="h-8 w-8 text-slate-600" />
        </div>
        <p className="text-slate-400 text-sm">No reviews yet</p>
        <p className="text-slate-500 text-xs mt-1">
          Be the first to share your experience
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {reviews.map((review) => (
        <div
          key={review.id}
          className="p-5 rounded-2xl bg-white/[0.02] border border-white/5 hover:border-white/10 transition-colors"
        >
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-500 to-blue-500 flex items-center justify-center">
                <span className="text-white text-sm font-bold">
                  {review.userAddress.slice(0, 2).toUpperCase()}
                </span>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white">
                    {formatAddress(review.userAddress)}
                  </span>
                  {review.verified && (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-bold uppercase tracking-wider">
                      Verified Buyer
                    </span>
                  )}
                  {review.status === "flagged" && (
                    <span className="px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1">
                      <ShieldAlert className="h-3 w-3" /> Under Moderation
                    </span>
                  )}
                </div>
                <span className="text-xs text-slate-500">
                  {formatDate(review.createdAt)}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <StarRating rating={review.rating} readonly size="sm" />
              {currentWallet && (
                <button
                  onClick={() => {
                    setReportingId(reportingId === review.id ? null : review.id);
                    setErrorMsg(null);
                  }}
                  title="Report this review"
                  className="p-1 text-slate-500 hover:text-rose-400 transition-colors"
                >
                  <Flag className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <p className="text-sm text-slate-300 leading-relaxed">
            {review.text}
          </p>

          {/* Report Feedback / Form */}
          {reportSuccessId === review.id && (
            <div className="mt-3 flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 p-2 rounded-lg">
              <CheckCircle2 className="h-4 w-4" /> Reported for maintainer moderation.
            </div>
          )}

          {reportingId === review.id && (
            <div className="mt-4 p-3 rounded-xl border border-white/10 bg-white/[0.03] space-y-2">
              <label className="text-xs text-slate-300 font-medium">Reason for report:</label>
              <input
                type="text"
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                placeholder="Spam, offensive language, inaccurate rating..."
                className="w-full text-xs bg-slate-900 border border-white/15 rounded-md p-2 text-white placeholder:text-slate-500"
              />
              {errorMsg && <p className="text-[11px] text-rose-400">{errorMsg}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-slate-400"
                  onClick={() => setReportingId(null)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs bg-rose-500/20 text-rose-300 hover:bg-rose-500/30 border border-rose-500/30"
                  disabled={isSubmitting}
                  onClick={() => handleReportSubmit(review)}
                >
                  Submit Report
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
