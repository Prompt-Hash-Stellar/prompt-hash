import { useState, useEffect, useMemo } from "react";
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  HelpCircle,
  Loader2,
  RefreshCw,
  Scale,
  ShieldAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { stellarNetwork } from "@/lib/env";

export interface PayoutLineItem {
  lineItemId: string;
  date: string;
  type: "sale" | "platform_fee" | "refund" | "clawback" | "carryover";
  promptId?: string;
  promptTitle?: string;
  buyerWallet?: string;
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
  status: "pending" | "settled" | "failed" | "refunded" | "clawback";
  txHash?: string;
  notes?: string;
}

export interface PayoutStatementData {
  statementId: string;
  creatorWallet: string;
  periodStart: string;
  periodEnd: string;
  grossAmount: number;
  platformFeeAmount: number;
  refundAmount: number;
  previousBalanceCarryover: number;
  netSettlementAmount: number;
  closingBalanceCarryover: number;
  payableAmount: number;
  currency: string;
  status: "pending" | "settled" | "failed";
  payoutTxHash?: string | null;
  failureReason?: string | null;
  settledAt?: string | null;
  lineItems: PayoutLineItem[];
}

interface PayoutStatementsCardProps {
  walletAddress: string;
}

export function PayoutStatementsCard({ walletAddress }: PayoutStatementsCardProps) {
  const [periodStart, setPeriodStart] = useState<string>(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().split("T")[0];
  });
  const [periodEnd, setPeriodEnd] = useState<string>(() => {
    return new Date().toISOString().split("T")[0];
  });

  const [statement, setStatement] = useState<PayoutStatementData | null>(null);
  const [historicalStatements, setHistoricalStatements] = useState<PayoutStatementData[]>([]);
  const [selectedStatementId, setSelectedStatementId] = useState<string>("preview");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isExportingCsv, setIsExportingCsv] = useState<boolean>(false);
  const [isExportingJson, setIsExportingJson] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [showLineItems, setShowLineItems] = useState<boolean>(true);

  // Load list of stored historical statements
  useEffect(() => {
    if (!walletAddress) return;
    fetch(`/api/payouts/statements/${walletAddress}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load historical statements");
        return res.json();
      })
      .then((data) => {
        if (data.statements) {
          setHistoricalStatements(data.statements);
        }
      })
      .catch((err) => {
        console.warn("Could not load historical statements:", err);
      });
  }, [walletAddress]);

  // Fetch or calculate statement preview
  const fetchStatement = async (overrideStart?: string, overrideEnd?: string) => {
    if (!walletAddress) return;
    setIsLoading(true);
    setError(null);

    const start = overrideStart || periodStart;
    const end = overrideEnd || periodEnd;

    try {
      if (selectedStatementId !== "preview") {
        const res = await fetch(
          `/api/payouts/statements/${walletAddress}/${selectedStatementId}`
        );
        if (!res.ok) throw new Error("Failed to fetch statement details.");
        const data = await res.json();
        setStatement(data.statement);
      } else {
        const startIso = new Date(`${start}T00:00:00.000Z`).toISOString();
        const endIso = new Date(`${end}T23:59:59.999Z`).toISOString();
        const res = await fetch(
          `/api/payouts/statements/${walletAddress}?preview=true&periodStart=${encodeURIComponent(startIso)}&periodEnd=${encodeURIComponent(endIso)}`
        );
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || "Failed to calculate reconciliation statement.");
        }
        const data = await res.json();
        setStatement(data.statement);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to load settlement statement.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStatement();
  }, [walletAddress, selectedStatementId]);

  const handleApplyFilter = () => {
    setSelectedStatementId("preview");
    fetchStatement();
  };

  const handleExport = async (format: "csv" | "json") => {
    if (!statement) return;
    if (format === "csv") setIsExportingCsv(true);
    else setIsExportingJson(true);

    try {
      if (selectedStatementId !== "preview" && statement.statementId) {
        window.open(
          `/api/payouts/statements/${walletAddress}/${statement.statementId}/export?format=${format}`,
          "_blank"
        );
      } else {
        // Generate CSV or JSON client-side if in on-the-fly preview mode
        if (format === "json") {
          const blob = new Blob([JSON.stringify(statement, null, 2)], {
            type: "application/json",
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `statement_preview_${periodStart}_to_${periodEnd}.json`;
          a.click();
          URL.revokeObjectURL(url);
        } else {
          // Construct client CSV
          const rows: string[] = [];
          rows.push("STATEMENT SUMMARY");
          rows.push(`Statement ID,${statement.statementId || "PREVIEW"}`);
          rows.push(`Creator Wallet,${statement.creatorWallet}`);
          rows.push(`Period Start,${statement.periodStart}`);
          rows.push(`Period End,${statement.periodEnd}`);
          rows.push(`Currency,${statement.currency}`);
          rows.push(`Gross Sales,${statement.grossAmount.toFixed(7)}`);
          rows.push(`Platform Fee (5%),${statement.platformFeeAmount.toFixed(7)}`);
          rows.push(`Refunds & Clawbacks,${statement.refundAmount.toFixed(7)}`);
          rows.push(`Previous Balance Carryover,${statement.previousBalanceCarryover.toFixed(7)}`);
          rows.push(`Net Settlement Amount,${statement.netSettlementAmount.toFixed(7)}`);
          rows.push(`Payable Amount,${statement.payableAmount.toFixed(7)}`);
          rows.push(`Status,${statement.status}`);
          rows.push("");
          rows.push("TRANSACTION LINE ITEMS");
          rows.push(
            "Line ID,Date,Type,Prompt ID,Prompt Title,Buyer Wallet,Gross,Fee,Net,Status,Tx Hash"
          );
          for (const item of statement.lineItems || []) {
            rows.push(
              [
                item.lineItemId,
                item.date,
                item.type,
                item.promptId || "",
                `"${(item.promptTitle || "").replace(/"/g, '""')}"`,
                item.buyerWallet || "",
                item.grossAmount.toFixed(7),
                item.feeAmount.toFixed(7),
                item.netAmount.toFixed(7),
                item.status,
                item.txHash || "",
              ].join(",")
            );
          }
          const blob = new Blob([rows.join("\r\n")], { type: "text/csv;charset=utf-8;" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `statement_preview_${periodStart}_to_${periodEnd}.csv`;
          a.click();
          URL.revokeObjectURL(url);
        }
      }
    } catch (err: any) {
      console.error("Export error:", err);
    } finally {
      setIsExportingCsv(false);
      setIsExportingJson(false);
    }
  };

  const getExplorerTxUrl = (txHash: string) => {
    const isTestnet = stellarNetwork.toLowerCase() !== "public";
    return `https://stellar.expert/explorer/${isTestnet ? "testnet" : "public"}/tx/${txHash}`;
  };

  return (
    <Card className="border-white/10 bg-white/[0.02]">
      <CardContent className="p-6 space-y-6">
        {/* Header Section */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Scale className="h-5 w-5 text-cyan-400" />
              <h2 className="text-xl font-bold text-white tracking-wide">
                Settlement Reconciliation &amp; Payout Statements
              </h2>
            </div>
            <p className="text-sm text-slate-400 mt-1">
              Transparent accounting of sales, 5% platform fees, refunds, and net settlements.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleExport("csv")}
              disabled={isLoading || !statement || isExportingCsv}
              className="border-white/10 text-slate-200 hover:bg-white/10 hover:text-white"
            >
              {isExportingCsv ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <FileSpreadsheet className="h-4 w-4 mr-1.5 text-emerald-400" />
              )}
              Export CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleExport("json")}
              disabled={isLoading || !statement || isExportingJson}
              className="border-white/10 text-slate-200 hover:bg-white/10 hover:text-white"
            >
              {isExportingJson ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <FileText className="h-4 w-4 mr-1.5 text-cyan-400" />
              )}
              Export JSON
            </Button>
          </div>
        </div>

        {/* Date Filter & Statement Selector Controls */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4 rounded-xl border border-white/5 bg-white/[0.02] p-3">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Statement Source
            </label>
            <select
              value={selectedStatementId}
              onChange={(e) => setSelectedStatementId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-cyan-400"
            >
              <option value="preview">Live Period Calculation</option>
              {historicalStatements.map((s) => (
                <option key={s.statementId} value={s.statementId}>
                  {s.statementId} ({new Date(s.periodStart).toLocaleDateString()} -{" "}
                  {new Date(s.periodEnd).toLocaleDateString()}) [{s.status}]
                </option>
              ))}
            </select>
          </div>

          {selectedStatementId === "preview" && (
            <>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Period Start
                </label>
                <Input
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                  className="mt-1 border-white/10 bg-slate-900 text-white"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Period End
                </label>
                <Input
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                  className="mt-1 border-white/10 bg-slate-900 text-white"
                />
              </div>
              <div className="flex items-end">
                <Button
                  onClick={handleApplyFilter}
                  disabled={isLoading}
                  className="w-full bg-cyan-600 hover:bg-cyan-500 text-white"
                >
                  {isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-1.5" />
                  )}
                  Reconcile
                </Button>
              </div>
            </>
          )}
        </div>

        {error && (
          <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
            <AlertCircle className="h-5 w-5 text-red-400 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-12 text-slate-400">
            <Loader2 className="h-8 w-8 animate-spin text-cyan-400 mb-3" />
            <p className="text-sm">Calculating reconciliation balance and ledger line items...</p>
          </div>
        ) : statement ? (
          <div className="space-y-6">
            {/* Status Alert Banner */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="flex items-center gap-3">
                {statement.status === "settled" ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
                ) : statement.status === "failed" ? (
                  <ShieldAlert className="h-5 w-5 text-red-400 shrink-0" />
                ) : (
                  <Clock className="h-5 w-5 text-amber-400 shrink-0" />
                )}
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-white">Settlement Status:</span>
                    <Badge
                      className={
                        statement.status === "settled"
                          ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                          : statement.status === "failed"
                          ? "bg-red-500/20 text-red-300 border-red-500/30"
                          : "bg-amber-500/20 text-amber-300 border-amber-500/30"
                      }
                    >
                      {statement.status.toUpperCase()}
                    </Badge>
                  </div>
                  {statement.payoutTxHash && (
                    <a
                      href={getExplorerTxUrl(statement.payoutTxHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1 mt-0.5"
                    >
                      Tx: {statement.payoutTxHash.slice(0, 16)}...
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {statement.failureReason && (
                    <p className="text-xs text-red-300 mt-0.5">
                      Error: {statement.failureReason}
                    </p>
                  )}
                </div>
              </div>

              <div className="text-right text-xs text-slate-400">
                <p>Period: {new Date(statement.periodStart).toLocaleDateString()} — {new Date(statement.periodEnd).toLocaleDateString()}</p>
                <p>Formula: Gross − Platform Fee (5%) − Refunds = Net</p>
              </div>
            </div>

            {/* Reconciliation Metric Cards */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <div className="flex items-center justify-between text-slate-400 mb-1">
                  <span className="text-xs uppercase font-semibold">Gross Sales</span>
                  <ArrowUpRight className="h-4 w-4 text-emerald-400" />
                </div>
                <p className="text-2xl font-bold text-white tabular-nums">
                  {statement.grossAmount.toFixed(2)}{" "}
                  <span className="text-xs font-normal text-slate-400">XLM</span>
                </p>
                <p className="text-xs text-slate-500 mt-1">Total buyer volume</p>
              </div>

              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <div className="flex items-center justify-between text-slate-400 mb-1">
                  <span className="text-xs uppercase font-semibold">Platform Fee (5%)</span>
                  <span className="text-xs text-amber-400 font-mono">500 bps</span>
                </div>
                <p className="text-2xl font-bold text-amber-300 tabular-nums">
                  −{statement.platformFeeAmount.toFixed(2)}{" "}
                  <span className="text-xs font-normal text-slate-400">XLM</span>
                </p>
                <p className="text-xs text-slate-500 mt-1">Protocol maintenance</p>
              </div>

              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <div className="flex items-center justify-between text-slate-400 mb-1">
                  <span className="text-xs uppercase font-semibold">Refunds &amp; Clawbacks</span>
                  <ArrowDownRight className="h-4 w-4 text-red-400" />
                </div>
                <p className="text-2xl font-bold text-red-400 tabular-nums">
                  −{statement.refundAmount.toFixed(2)}{" "}
                  <span className="text-xs font-normal text-slate-400">XLM</span>
                </p>
                <p className="text-xs text-slate-500 mt-1">Disputes &amp; reversals</p>
              </div>

              <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/[0.05] p-4">
                <div className="flex items-center justify-between text-slate-400 mb-1">
                  <span className="text-xs uppercase font-semibold text-cyan-300">Net Settlement</span>
                  <Scale className="h-4 w-4 text-cyan-400" />
                </div>
                <p className="text-2xl font-bold text-cyan-200 tabular-nums">
                  {statement.netSettlementAmount.toFixed(2)}{" "}
                  <span className="text-xs font-normal text-slate-400">XLM</span>
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  Payable: {statement.payableAmount.toFixed(2)} XLM
                </p>
              </div>
            </div>

            {/* Carryover Deficit Notice if present */}
            {statement.closingBalanceCarryover < 0 && (
              <div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200">
                <AlertCircle className="h-4 w-4 text-amber-400 shrink-0" />
                <div>
                  <p className="font-semibold">Negative Balance Carryover</p>
                  <p>
                    Deductions and refunds in this period exceed gross sales by{" "}
                    {Math.abs(statement.closingBalanceCarryover).toFixed(2)} XLM. This deficit
                    will carry forward to the subsequent period.
                  </p>
                </div>
              </div>
            )}

            {/* Itemized Line Items Table */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white tracking-wide">
                  Itemized Transactions ({statement.lineItems?.length || 0})
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowLineItems(!showLineItems)}
                  className="text-xs text-slate-400 hover:text-white"
                >
                  {showLineItems ? "Collapse Ledger" : "Expand Ledger"}
                </Button>
              </div>

              {showLineItems && (
                <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.01]">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-white/10 bg-white/[0.03] text-slate-400 font-semibold uppercase">
                      <tr>
                        <th className="px-4 py-3">Date</th>
                        <th className="px-4 py-3">Type</th>
                        <th className="px-4 py-3">Prompt</th>
                        <th className="px-4 py-3">Buyer / Party</th>
                        <th className="px-4 py-3 text-right">Gross</th>
                        <th className="px-4 py-3 text-right">Fee (5%)</th>
                        <th className="px-4 py-3 text-right">Net</th>
                        <th className="px-4 py-3 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 text-slate-300">
                      {statement.lineItems?.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="py-8 text-center text-slate-500">
                            No transactions found for this period window.
                          </td>
                        </tr>
                      ) : (
                        statement.lineItems.map((item) => (
                          <tr key={item.lineItemId} className="hover:bg-white/[0.02] transition-colors">
                            <td className="px-4 py-3 whitespace-nowrap text-slate-400 font-mono">
                              {new Date(item.date).toLocaleDateString()}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              <Badge
                                variant="outline"
                                className={
                                  item.type === "sale"
                                    ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
                                    : item.type === "clawback"
                                    ? "border-red-500/30 text-red-400 bg-red-500/10"
                                    : item.type === "carryover"
                                    ? "border-amber-500/30 text-amber-400 bg-amber-500/10"
                                    : "border-cyan-500/30 text-cyan-400 bg-cyan-500/10"
                                }
                              >
                                {item.type.toUpperCase()}
                              </Badge>
                            </td>
                            <td className="px-4 py-3 max-w-[200px] truncate text-white">
                              {item.promptTitle || `#${item.promptId || "N/A"}`}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-slate-400 font-mono">
                              {item.buyerWallet
                                ? `${item.buyerWallet.slice(0, 6)}...${item.buyerWallet.slice(-4)}`
                                : "—"}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums text-slate-200">
                              {item.grossAmount > 0 ? `${item.grossAmount.toFixed(2)} XLM` : "—"}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums text-amber-400">
                              {item.feeAmount > 0 ? `−${item.feeAmount.toFixed(2)} XLM` : "—"}
                            </td>
                            <td
                              className={`px-4 py-3 text-right tabular-nums font-semibold ${
                                item.netAmount >= 0 ? "text-emerald-300" : "text-red-400"
                              }`}
                            >
                              {item.netAmount >= 0
                                ? `+${item.netAmount.toFixed(2)}`
                                : item.netAmount.toFixed(2)}{" "}
                              XLM
                            </td>
                            <td className="px-4 py-3 text-center whitespace-nowrap">
                              <span
                                className={`inline-block rounded-full px-2 py-0.5 text-[10px] uppercase font-semibold ${
                                  item.status === "settled"
                                    ? "bg-emerald-500/20 text-emerald-300"
                                    : item.status === "refunded"
                                    ? "bg-red-500/20 text-red-300"
                                    : "bg-amber-500/20 text-amber-300"
                                }`}
                              >
                                {item.status}
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
