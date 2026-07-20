import { describe, expect, it } from "vitest";
import { loadStellarConfig } from "./stellar";

const valid = {
  PUBLIC_STELLAR_NETWORK: "TESTNET",
  PUBLIC_STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  PUBLIC_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  PUBLIC_STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
  PUBLIC_PROMPT_HASH_CONTRACT_ID: `C${"A".repeat(55)}`,
  PUBLIC_STELLAR_NATIVE_ASSET_CONTRACT_ID: `C${"B".repeat(55)}`,
};

describe("loadStellarConfig", () => {
  it("returns an immutable typed config", () => expect(Object.isFrozen(loadStellarConfig(valid))).toBe(true));
  it("fails fast when required values are missing", () => expect(() => loadStellarConfig({})).toThrow(/Invalid Stellar configuration/));
  it("rejects malformed contract ids", () => expect(() => loadStellarConfig({ ...valid, PUBLIC_PROMPT_HASH_CONTRACT_ID: "bad" })).toThrow());
});
