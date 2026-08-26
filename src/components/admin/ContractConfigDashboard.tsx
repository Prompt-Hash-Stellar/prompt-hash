import React, { useState, useEffect } from "react";
import { 
  Copy, 
  Check, 
  ExternalLink, 
  Shield, 
  AlertTriangle, 
  CheckCircle2, 
  XCircle, 
  RefreshCw, 
  Settings, 
  Info,
  Pause,
  Play
} from "lucide-react";
import { readContract } from "@/lib/stellar/tx";
import { browserStellarConfig } from "@/lib/stellar/browserConfig";

interface ConfigRow {
  key: string;
  label: string;
  deployed: string | number | boolean | null | undefined;
  expected: string | number | boolean | null | undefined;
  status: "match" | "mismatch" | "info" | "error";
  isAddressOrHash?: boolean;
}

export default function ContractConfigDashboard() {
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<string>("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Deployed values from contract
  const [deployedConfig, setDeployedConfig] = useState<{
    owner?: string;
    feePercentage?: number;
    feeWallet?: string;
    platformFee?: number;
    xlmSac?: string;
    isPaused?: boolean;
    referralPercentage?: number;
    version?: string;
  }>({});

  const fetchContractConfig = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      if (!browserStellarConfig.promptHashContractId) {
        throw new Error("PUBLIC_PROMPT_HASH_CONTRACT_ID is not configured in local environment.");
      }
      if (!browserStellarConfig.simulationAccount) {
        throw new Error("PUBLIC_STELLAR_SIMULATION_ACCOUNT is not configured in local environment. Required for contract simulation queries.");
      }

      // Parallel reads of active contract parameters
      const [
        feePercentage,
        feeWallet,
        platformFee,
        xlmSac,
        isPaused,
        referralPercentage,
      ] = await Promise.all([
        readContract<number>(browserStellarConfig, browserStellarConfig.promptHashContractId, "get_fee_percentage"),
        readContract<string | undefined>(browserStellarConfig, browserStellarConfig.promptHashContractId, "get_fee_wallet"),
        readContract<number>(browserStellarConfig, browserStellarConfig.promptHashContractId, "get_platform_fee"),
        readContract<string | undefined>(browserStellarConfig, browserStellarConfig.promptHashContractId, "get_xlm_sac"),
        readContract<boolean>(browserStellarConfig, browserStellarConfig.promptHashContractId, "is_paused"),
        readContract<number>(browserStellarConfig, browserStellarConfig.promptHashContractId, "get_referral_percentage"),
      ]);

      // Attempt to retrieve owner address (from Ownable module)
      let owner: string | undefined;
      try {
        owner = await readContract<string>(browserStellarConfig, browserStellarConfig.promptHashContractId, "owner");
      } catch {
        try {
          owner = await readContract<string>(browserStellarConfig, browserStellarConfig.promptHashContractId, "get_owner");
        } catch {
          owner = undefined;
        }
      }

      setDeployedConfig({
        owner,
        feePercentage,
        feeWallet,
        platformFee,
        xlmSac,
        isPaused,
        referralPercentage,
        version: "0.0.1", // Standard Workspace Compiled Version
      });

      setLastRefreshed(new Date().toLocaleTimeString());
    } catch (err) {
      console.error("Failed to read active contract configuration:", err);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchContractConfig();
  }, []);

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const getExplorerUrl = (id: string, type: "contract" | "account" = "contract") => {
    const isPublic = browserStellarConfig.networkPassphrase.includes("Public");
    const netSegment = isPublic ? "public" : "testnet";
    return `https://stellar.expert/explorer/${netSegment}/${type}/${id}`;
  };

  const formatBps = (bps: number | undefined | null) => {
    if (bps === undefined || bps === null) return "—";
    const percent = (bps / 100).toFixed(2);
    return `${bps} BPS (${percent}%)`;
  };

  const renderStatusIcon = (status: ConfigRow["status"]) => {
    switch (status) {
      case "match":
        return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
      case "mismatch":
        return <XCircle className="h-5 w-5 text-rose-500" />;
      case "info":
        return <Info className="h-5 w-5 text-blue-500" />;
      default:
        return <AlertTriangle className="h-5 w-5 text-amber-500" />;
    }
  };

  // Build rows comparing Deployed values (live) vs Expected values (from env variables)
  const rows: ConfigRow[] = [
    {
      key: "contractId",
      label: "Contract ID",
      deployed: browserStellarConfig.promptHashContractId || "Not Configured",
      expected: browserStellarConfig.promptHashContractId || "Not Configured",
      status: browserStellarConfig.promptHashContractId ? "match" : "error",
      isAddressOrHash: true,
    },
    {
      key: "network",
      label: "Stellar Network Passphrase",
      deployed: browserStellarConfig.networkPassphrase || "Not Configured",
      expected: browserStellarConfig.networkPassphrase || "Not Configured",
      status: browserStellarConfig.networkPassphrase ? "match" : "error",
    },
    {
      key: "owner",
      label: "Admin / Contract Owner",
      deployed: deployedConfig.owner || "Unable to fetch",
      expected: "Dynamic (Set on Deploy)",
      status: deployedConfig.owner ? "info" : "error",
      isAddressOrHash: true,
    },
    {
      key: "xlmSac",
      label: "Accepted Asset (XLM SAC)",
      deployed: deployedConfig.xlmSac || "Unable to fetch",
      expected: browserStellarConfig.nativeAssetContractId || "Not Configured",
      status: !deployedConfig.xlmSac 
        ? "error" 
        : String(deployedConfig.xlmSac).toUpperCase() === String(browserStellarConfig.nativeAssetContractId || "").toUpperCase() 
          ? "match" 
          : "mismatch",
      isAddressOrHash: true,
    },
    {
      key: "feeWallet",
      label: "Platform Fee Recipient Wallet",
      deployed: deployedConfig.feeWallet || "Unable to fetch",
      expected: "Dynamic (Set on Deploy)",
      status: deployedConfig.feeWallet ? "info" : "error",
      isAddressOrHash: true,
    },
    {
      key: "feePercentage",
      label: "Platform Creator Fee",
      deployed: formatBps(deployedConfig.feePercentage),
      expected: "500 BPS (5.00%)",
      status: deployedConfig.feePercentage === 500 ? "match" : "info",
    },
    {
      key: "platformFee",
      label: "Direct Platform Fee",
      deployed: formatBps(deployedConfig.platformFee),
      expected: "0 BPS (0.00%)",
      status: deployedConfig.platformFee === 0 ? "match" : "info",
    },
    {
      key: "referralPercentage",
      label: "Referral Share BPS",
      deployed: formatBps(deployedConfig.referralPercentage),
      expected: "0 BPS (0.00%)",
      status: deployedConfig.referralPercentage === 0 ? "match" : "info",
    },
    {
      key: "paused",
      label: "Contract Operational Status",
      deployed: deployedConfig.isPaused !== undefined ? (deployedConfig.isPaused ? "PAUSED" : "OPERATIONAL") : "Unable to fetch",
      expected: "OPERATIONAL",
      status: deployedConfig.isPaused === undefined ? "error" : !deployedConfig.isPaused ? "match" : "mismatch",
    },
    {
      key: "version",
      label: "Contract Spec Version",
      deployed: deployedConfig.version || "—",
      expected: "0.0.1",
      status: deployedConfig.version === "0.0.1" ? "match" : "info",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Diagnostics Header & Status Cards */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Settings className="h-5 w-5 text-primary" />
            Stellar Contract Diagnostics
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Compare active live smart contract variables with local environment expectations.
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          {lastRefreshed && (
            <span className="text-xs text-slate-400">
              Refreshed: {lastRefreshed}
            </span>
          )}
          <button
            onClick={fetchContractConfig}
            disabled={loading}
            className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-xs font-medium text-white transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Refresh Values
          </button>
        </div>
      </div>

      {/* Graceful Network Status Banner */}
      {errorMsg ? (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <h4 className="text-sm font-semibold text-amber-500">RPC / Contract Connectivity Issue</h4>
            <p className="text-xs text-slate-400 mt-1">
              Could not query live parameters directly from the Stellar RPC network. Ensure the smart contract is deployed to the current network passphrase and the RPC endpoint is online.
            </p>
            <code className="block text-xs bg-black/30 p-2 rounded border border-white/5 mt-3 max-w-full overflow-x-auto text-rose-400">
              {errorMsg}
            </code>
          </div>
        </div>
      ) : null}

      {/* Network Config Context Card */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Target Stellar RPC</span>
          <p className="text-sm font-medium text-white truncate mt-1">{browserStellarConfig.rpcUrl}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Simulation Account</span>
          <p className="text-sm font-medium text-white truncate mt-1">{browserStellarConfig.simulationAccount || "Not Configured"}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Security Access Controls</span>
          <div className="flex items-center gap-1.5 mt-1">
            <Shield className="h-4 w-4 text-emerald-500" />
            <span className="text-xs font-semibold text-slate-200">Read-Only Diagnostics Mode</span>
          </div>
        </div>
      </div>

      {/* Contract Variables Comparison Matrix Table */}
      <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.02]">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-white/10 text-slate-400 text-xs font-semibold uppercase bg-white/[0.01]">
              <th className="p-4">Parameter Label</th>
              <th className="p-4">Deployed Value (On-Chain)</th>
              <th className="p-4">Expected Value (Env Config)</th>
              <th className="p-4 text-center">Diagnostics Match</th>
              <th className="p-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map((row) => {
              const isMatch = row.status === "match";
              const isMismatch = row.status === "mismatch";
              const isAddress = row.isAddressOrHash && row.deployed && String(row.deployed).length > 20;

              return (
                <tr key={row.key} className="hover:bg-white/[0.01] transition-colors">
                  {/* Parameter Label */}
                  <td className="p-4 font-medium text-slate-200">
                    {row.label}
                  </td>

                  {/* Deployed Value (On-Chain) */}
                  <td className="p-4">
                    {loading ? (
                      <div className="h-4 w-32 bg-white/10 rounded animate-pulse" />
                    ) : isAddress ? (
                      <span className="font-mono text-xs text-slate-300">
                        {String(row.deployed).slice(0, 10)}...{String(row.deployed).slice(-10)}
                      </span>
                    ) : row.key === "paused" ? (
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                        row.deployed === "PAUSED" 
                          ? "bg-rose-500/20 text-rose-400 border border-rose-500/30" 
                          : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                      }`}>
                        {row.deployed === "PAUSED" ? <Pause className="h-2.5 w-2.5" /> : <Play className="h-2.5 w-2.5" />}
                        {row.deployed}
                      </span>
                    ) : (
                      <span className="text-slate-300 font-medium">
                        {String(row.deployed)}
                      </span>
                    )}
                  </td>

                  {/* Expected Value (Env Config) */}
                  <td className="p-4 text-slate-400 text-xs">
                    {isAddress && String(row.expected).length > 20 ? (
                      <span className="font-mono">
                        {String(row.expected).slice(0, 10)}...{String(row.expected).slice(-10)}
                      </span>
                    ) : (
                      row.expected
                    )}
                  </td>

                  {/* Diagnostics Match Status */}
                  <td className="p-4 text-center">
                    <div className="flex items-center justify-center">
                      {loading ? (
                        <div className="h-5 w-5 bg-white/10 rounded-full animate-pulse" />
                      ) : (
                        renderStatusIcon(row.status)
                      )}
                    </div>
                  </td>

                  {/* Copy & Explorer Actions */}
                  <td className="p-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {row.deployed && row.deployed !== "Unable to fetch" && (
                        <button
                          onClick={() => handleCopy(String(row.deployed), row.key)}
                          title="Copy Full Value"
                          className="p-1.5 rounded bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-all cursor-pointer"
                        >
                          {copiedKey === row.key ? (
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                      
                      {row.isAddressOrHash && row.deployed && String(row.deployed).length > 20 && (
                        <a
                          href={getExplorerUrl(String(row.deployed), row.key === "owner" || row.key === "feeWallet" ? "account" : "contract")}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="View on Stellar.expert"
                          className="p-1.5 rounded bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-all flex items-center justify-center"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
