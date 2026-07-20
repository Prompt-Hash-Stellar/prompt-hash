import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, X, ExternalLink, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/hooks/useWallet";

interface WalletOption {
  id: string;
  name: string;
  icon: string;
  descriptionKey: string;
  installUrl?: string;
}

// Wallet names are proper nouns/brand names and are intentionally not translated.
const WALLET_OPTIONS: WalletOption[] = [
  {
    id: "freighter",
    name: "Freighter",
    icon: "🦊",
    descriptionKey: "wallet.modal.wallets.freighter",
    installUrl: "https://freighter.app",
  },
  {
    id: "xbull",
    name: "xBull",
    icon: "🐂",
    descriptionKey: "wallet.modal.wallets.xbull",
    installUrl: "https://xbull.app",
  },
  {
    id: "albedo",
    name: "Albedo",
    icon: "🌌",
    descriptionKey: "wallet.modal.wallets.albedo",
    installUrl: "https://albedo.link",
  },
  {
    id: "lobstr",
    name: "Lobstr",
    icon: "🦞",
    descriptionKey: "wallet.modal.wallets.lobstr",
    installUrl: "https://lobstr.co",
  },
  {
    id: "rabet",
    name: "Rabet",
    icon: "🐰",
    descriptionKey: "wallet.modal.wallets.rabet",
    installUrl: "https://rabet.io",
  },
];

const E2E_WALLET: WalletOption = {
  id: "e2e-mock",
  name: "E2E Mock Wallet",
  icon: "🧪",
  description: "Deterministic local wallet for browser tests",
};

interface WalletModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function WalletModal({ isOpen, onClose }: WalletModalProps) {
  const { t } = useTranslation();
  const { connect, status, error } = useWallet();
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  if (!isOpen) return null;

  const options =
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("e2e") === "1"
      ? [E2E_WALLET, ...WALLET_OPTIONS]
      : WALLET_OPTIONS;

  const handleConnect = async (walletId: string) => {
    setConnectingId(walletId);
    setConnectionError(null);

    try {
      await connect(walletId);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : t("wallet.modal.connection_failed");
      setConnectionError(message);
    } finally {
      setConnectingId(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50"
    >
      <div className="bg-slate-900 border border-white/10 rounded-2xl p-6 shadow-2xl max-w-md w-full mx-4 relative">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 id="modal-title" className="text-xl font-bold text-white">
              {t("wallet.modal.title")}
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              {t("wallet.modal.subtitle")}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label={t("wallet.modal.close")}
            className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-white/10"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Error message */}
        {(connectionError || (status === "error" && error)) && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {connectionError || error}
          </div>
        )}

        {/* Wallet options */}
        <div className="space-y-2">
          {options.map((wallet) => {
            const isConnecting = connectingId === wallet.id;

            return (
              <button
                key={wallet.id}
                onClick={() => void handleConnect(wallet.id)}
                disabled={connectingId !== null}
                className="w-full flex items-center gap-4 p-4 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed group"
              >
                <span className="text-2xl">{wallet.icon}</span>
                <div className="flex-1 text-left">
                  <div className="font-medium text-white group-hover:text-amber-300 transition-colors">
                    {wallet.name}
                  </div>
                  <div className="text-xs text-slate-400">
                    {t(wallet.descriptionKey)}
                  </div>
                </div>
                {isConnecting ? (
                  <Loader2 className="w-5 h-5 animate-spin text-amber-400" />
                ) : (
                  <ExternalLink className="w-4 h-4 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" />
                )}
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div className="mt-6 pt-4 border-t border-white/10">
          <p className="text-xs text-slate-500 text-center">
            {t("wallet.modal.new_to_stellar")}{" "}
            <a
              href="https://stellar.org/learn/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-400 hover:text-amber-300 transition-colors"
            >
              {t("wallet.modal.learn_about_wallets")}
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
