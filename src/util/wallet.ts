import { 
  StellarWalletsKit, 
  WalletNetwork, 
  allowAllModules 
} from "@creit.tech/stellar-wallets-kit";
import { Horizon, extractBaseAddress, StrKey } from "@stellar/stellar-sdk";
import { horizonUrl, stellarNetwork, stellarWalletNetwork } from "../lib/env";

// allowAllModules() returns an array containing albedo, freighter, etc.
// This prevents us from having to import them individually and hitting the "Missing Export" error.
export const kit: StellarWalletsKit = new StellarWalletsKit({
  network: stellarWalletNetwork as WalletNetwork,
  modules: allowAllModules(),
});

function getHorizonHost(mode: string) {
  switch (mode) {
    case "LOCAL":
    case "FUTURENET":
    case "TESTNET":
    case "PUBLIC":
      return horizonUrl;
    default:
      throw new Error(`Unknown Stellar network: ${mode}`);
  }
}

export const fetchBalance = async (address: string) => {
  const horizon = new Horizon.Server(getHorizonHost(stellarNetwork), {
    allowHttp: stellarNetwork === "LOCAL",
  });

  try {
    const baseAddress = address.startsWith("M") ? extractBaseAddress(address) : address;
    const { balances } = await horizon.accounts().accountId(baseAddress).call();
    return { ok: true, balances };
  } catch (e) {
    // Re-throw the error so callers can handle it appropriately
    console.error("Error fetching balance:", e);
    throw e;
  }
};

export const validatePayoutAddress = async (address: string): Promise<{ valid: boolean, error?: string }> => {
  const isEd25519 = StrKey.isValidEd25519PublicKey(address);
  const isMuxed = StrKey.isValidMed25519PublicKey(address);

  if (!isEd25519 && !isMuxed) {
    return { valid: false, error: "Invalid Stellar payout address." };
  }

  const horizon = new Horizon.Server(getHorizonHost(stellarNetwork), {
    allowHttp: stellarNetwork === "LOCAL",
  });

  try {
    const baseAddress = isMuxed ? extractBaseAddress(address) : address;
    const account = await horizon.accounts().accountId(baseAddress).call();

    if (isEd25519 && account.data_attr && account.data_attr["config.memo_required"] === "MQ==") {
      return { valid: false, error: "Destination requires a memo. Please provide a Muxed Account (M...) address instead." };
    }

    return { valid: true };
  } catch (err: any) {
    if (err.response?.status === 404) {
      return { valid: false, error: "Payout account is not funded on the Stellar network." };
    }
    console.error("Error validating payout address:", err);
    return { valid: false, error: "Failed to validate payout address. Please try again." };
  }
};

export type Balance = Awaited<ReturnType<typeof fetchBalance>>["balances"][number];

export const wallet = kit;

// Restore removed connectWallet export for backward compatibility
export const connectWallet = async (...args: any[]) => {
  return (kit as any).openModal(...args);
};
