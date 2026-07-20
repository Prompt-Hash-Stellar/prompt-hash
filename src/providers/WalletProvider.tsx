import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
} from "react";
import { wallet } from "../util/wallet";
import storage from "../util/storage";
import { stellarWalletNetwork } from "../lib/env";
import { ALBEDO_ID } from "@creit.tech/stellar-wallets-kit";
import { useAsyncTransaction } from "../components/useAsyncTransaction";
import { classifyWalletError } from "../lib/wallet/walletErrors";

export type WalletStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export type NetworkCompatibility = "correct" | "wrong-network" | "unchecked";

export interface WalletContextType {
  address?: string;
  network?: string;
  networkPassphrase?: string;
  status: WalletStatus;
  error?: string;
  networkCompatibility: NetworkCompatibility;
  connect: (_id: string) => Promise<void>;
  disconnect: () => Promise<void>;
  signTransaction: typeof wallet.signTransaction;
  signMessage: typeof wallet.signMessage;
}

function computeNetworkCompatibility(
  network: string | undefined,
  status: WalletStatus,
): NetworkCompatibility {
  if (status !== "connected" || !network) return "unchecked";
  const expected = stellarWalletNetwork.toUpperCase();
  const actual = network.toUpperCase();
  return actual === expected ? "correct" : "wrong-network";
}

const initialState = {
  address: undefined,
  network: undefined,
  networkPassphrase: undefined,
  status: "idle" as WalletStatus,
  error: undefined,
  networkCompatibility: "unchecked" as NetworkCompatibility,
};

const boundSignTransaction = wallet.signTransaction.bind(wallet);
const boundSignMessage = wallet.signMessage.bind(wallet);
const E2E_WALLET_ID = "e2e-mock";
const E2E_WALLET_ADDRESS =
  "GBUYERACCOUNT1234567890ABCDEFGH1234567890ABCDEFGH123456789";

function e2eWalletEnabled() {
  return (
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("e2e") === "1"
  );
}

export const WalletContext = createContext<WalletContextType | undefined>(
  undefined,
);

export const WalletProvider = ({ children }: { children: React.ReactNode }) => {
  const [state, setState] =
    useState<
      Omit<
        WalletContextType,
        "connect" | "disconnect" | "signTransaction" | "signMessage"
      >
    >(initialState);
  const isConnectingRef = useRef(false);

  const { execute: executeDisconnect } = useAsyncTransaction(
    async () => {
      await wallet.disconnect();
    },
    {
      pendingMessage: "Disconnecting wallet...",
      successMessage: "Wallet disconnected",
      onSuccess: () => {
        storage.removeItem("walletId");
        storage.removeItem("walletAddress");
        storage.removeItem("walletNetwork");
        storage.removeItem("networkPassphrase");
        setState(initialState);
      },
    },
  );

  const disconnect = useCallback(async () => {
    await executeDisconnect().catch(console.error);
  }, [executeDisconnect]);

  // Helper to safely get network info (handles Albedo's lack of getNetwork support)
  const getSafeNetworkInfo = useCallback(async (walletId: string) => {
    // Albedo and some other web wallets don't support getNetwork
    if (walletId === ALBEDO_ID) {
      return { network: stellarWalletNetwork, networkPassphrase: undefined };
    }
    try {
      return await wallet.getNetwork();
    } catch {
      console.warn(
        `Wallet ${walletId} does not support getNetwork, using env default.`,
      );
      return { network: stellarWalletNetwork, networkPassphrase: undefined };
    }
  }, []);

  const { execute: executeConnect } = useAsyncTransaction(
    async (walletId: string) => {
      if (walletId === E2E_WALLET_ID && e2eWalletEnabled()) {
        return {
          address: E2E_WALLET_ADDRESS,
          network: stellarWalletNetwork,
          networkPassphrase: stellarWalletNetwork,
          walletId,
        };
      }

      wallet.setWallet(walletId);

      const [a, n] = await Promise.all([
        wallet.getAddress(),
        getSafeNetworkInfo(walletId),
      ]);

      if (!a.address) throw new Error("No address returned from wallet");
      return {
        address: a.address,
        network: n.network,
        networkPassphrase: n.networkPassphrase,
        walletId,
      };
    },
    {
      pendingMessage: (walletId) => `Connecting to ${walletId}...`,
      successMessage: "Wallet connected successfully",
      onOptimistic: () => {
        setState((prev) => ({
          ...prev,
          status: "connecting",
          error: undefined,
        }));
      },
      onSuccess: (data) => {
        storage.setItem("walletId", data.walletId);
        storage.setItem("walletAddress", data.address);
        if (data.network) storage.setItem("walletNetwork", data.network);
        else storage.removeItem("walletNetwork");

        if (data.networkPassphrase)
          storage.setItem("networkPassphrase", data.networkPassphrase);
        else storage.removeItem("networkPassphrase");

        setState({
          address: data.address,
          network: data.network,
          networkPassphrase: data.networkPassphrase,
          status: "connected",
          error: undefined,
          networkCompatibility: computeNetworkCompatibility(
            data.network,
            "connected",
          ),
        });
      },
      onError: (e) => {
        console.error("Connection error:", e);
        const classified = classifyWalletError(e);
        const message = classified.recoveryAction
          ? `${classified.message} ${classified.recoveryAction}`
          : classified.message;
        setState((prev) => ({
          ...prev,
          status: "error",
          error: message,
        }));
      },
    },
  );

  const connect = useCallback(
    async (walletId: string) => {
      if (
        state.status === "connecting" ||
        state.status === "reconnecting" ||
        isConnectingRef.current
      ) {
        return;
      }

      isConnectingRef.current = true;
      try {
        await executeConnect(walletId).catch(() => {});
      } finally {
        isConnectingRef.current = false;
      }
    },
    [executeConnect, state.status],
  );

  const checkExtensionAccount = useCallback(async () => {
    if (state.status !== "connected" && state.status !== "reconnecting") return;
    const savedId = storage.getItem("walletId");
    if (!savedId) return;

    try {
      const { address } = await wallet.getAddress();
      if (address && address !== state.address) {
        storage.setItem("walletAddress", address);
        setState((prev) => ({ ...prev, address }));
      }
    } catch (error) {
      console.error("Error checking extension account:", error);
    }
  }, [state.status, state.address]);

  useEffect(() => {
    const handleFocus = () => void checkExtensionAccount();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [checkExtensionAccount]);

  useEffect(() => {
    let aborted = false;

    const rehydrate = async () => {
      const savedId = storage.getItem("walletId");
      const savedAddr = storage.getItem("walletAddress");

      if (aborted) return;

      if (!savedId || !savedAddr) {
        setState((prev) => ({ ...prev, status: "idle" }));
        return;
      }

      setState((prev) => ({ ...prev, status: "reconnecting" }));

      if (savedId === E2E_WALLET_ID && e2eWalletEnabled()) {
        setState({
          address: savedAddr,
          network: stellarWalletNetwork,
          networkPassphrase: stellarWalletNetwork,
          status: "connected",
          error: undefined,
          networkCompatibility: "correct",
        });
        return;
      }

      try {
        wallet.setWallet(savedId);
        const [a, n] = await Promise.all([
          wallet.getAddress(),
          getSafeNetworkInfo(savedId),
        ]);

        if (aborted) return;
        if (state.status !== "reconnecting" && state.status !== "idle") return;

        if (a.address) {
          if (a.address !== savedAddr) {
            storage.setItem("walletAddress", a.address);
          }
          if (aborted) return;
          setState({
            address: a.address,
            network: n.network,
            networkPassphrase: n.networkPassphrase,
            status: "connected",
            error: undefined,
            networkCompatibility: computeNetworkCompatibility(
              n.network,
              "connected",
            ),
          });
        } else {
          if (aborted) return;
          disconnect();
        }
      } catch {
        if (aborted) return;
        console.warn("Session rehydration failed, clearing stale data.");
        disconnect();
      }
    };

    void rehydrate();

    return () => {
      aborted = true;
    };
  }, [disconnect, getSafeNetworkInfo]);

  const contextValue = useMemo(
    () => ({
      ...state,
      connect,
      disconnect,
      signTransaction: boundSignTransaction,
      signMessage: e2eWalletEnabled()
        ? async () => ({ signedMessage: "e2e-signed-challenge" })
        : boundSignMessage,
      networkCompatibility: state.networkCompatibility,
    }),
    [state, connect, disconnect],
  );

  return (
    <WalletContext.Provider value={contextValue}>
      {children}
    </WalletContext.Provider>
  );
};
