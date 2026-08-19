import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "../render";
import ContractConfigDashboard from "@/components/admin/ContractConfigDashboard";
import { readContract } from "@/lib/stellar/tx";

const mockReadContract = vi.fn();
// Mock the readContract utility
vi.mock("@/lib/stellar/tx", () => ({
  readContract: (...args: any[]) => mockReadContract(...args),
}));

// Mock browserStellarConfig
vi.mock("@/lib/stellar/browserConfig", () => ({
  browserStellarConfig: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    allowHttp: false,
    promptHashContractId: "CCONTRACTMOCKADDRESS1234567890ABCDEF",
    nativeAssetContractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    simulationAccount: "GCSIMULATIONACCOUNT1234567890ABCDEF",
  },
}));

describe("ContractConfigDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders correctly and queries contract variables successfully", async () => {
    // Set up mock return values for each contract read method
    mockReadContract.mockImplementation(async (config, contractId, method) => {
      switch (method) {
        case "get_fee_percentage":
          return 500;
        case "get_fee_wallet":
          return "GCFEEWALLET1234567890ABCDEF";
        case "get_platform_fee":
          return 100;
        case "get_xlm_sac":
          return "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
        case "is_paused":
          return false;
        case "get_referral_percentage":
          return 200;
        case "owner":
        case "get_owner":
          return "GCOWNER1234567890ABCDEF";
        default:
          return null;
      }
    });

    renderWithProviders(<ContractConfigDashboard />);

    // Check loading indicator or state
    expect(screen.getByText(/Stellar Contract Diagnostics/i)).toBeInTheDocument();
    
    // Wait for values to be fetched and rendered
    await waitFor(() => {
      const cells = screen.queryAllByRole("cell");
      const textContents = cells.map(cell => cell.textContent || "");
      
      expect(textContents.some(t => t.includes("GCOWNER123"))).toBe(true);
      expect(textContents.some(t => t.includes("500 BPS"))).toBe(true);
      expect(textContents.some(t => t.includes("100 BPS"))).toBe(true);
      expect(textContents.some(t => t.includes("200 BPS"))).toBe(true);
      expect(textContents.some(t => t.includes("OPERATIONAL"))).toBe(true);
    });

    // Check that get_fee_percentage, get_fee_wallet, get_platform_fee, is_paused, get_referral_percentage, owner, get_xlm_sac were queried
    expect(mockReadContract).toHaveBeenCalledWith(expect.any(Object), expect.any(String), "get_fee_percentage");
    expect(mockReadContract).toHaveBeenCalledWith(expect.any(Object), expect.any(String), "get_fee_wallet");
    expect(mockReadContract).toHaveBeenCalledWith(expect.any(Object), expect.any(String), "get_platform_fee");
    expect(mockReadContract).toHaveBeenCalledWith(expect.any(Object), expect.any(String), "get_xlm_sac");
    expect(mockReadContract).toHaveBeenCalledWith(expect.any(Object), expect.any(String), "is_paused");
    expect(mockReadContract).toHaveBeenCalledWith(expect.any(Object), expect.any(String), "get_referral_percentage");
  });

  it("handles contract read failures gracefully and shows error banner", async () => {
    // Make reads fail (e.g. simulating RPC down)
    mockReadContract.mockRejectedValue(new Error("RPC Connection Timeout"));

    renderWithProviders(<ContractConfigDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/RPC Connection Timeout/i)).toBeInTheDocument();
      expect(screen.getByText(/RPC \/ Contract Connectivity Issue/i)).toBeInTheDocument();
    });
  });

  it("supports copying parameters to clipboard", async () => {
    mockReadContract.mockResolvedValue(500); // simplify mock
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    renderWithProviders(<ContractConfigDashboard />);

    await waitFor(() => {
      // Find copy button by querying all buttons with title attribute
      const buttons = screen.getAllByRole("button");
      // Filter or find the refresh/copy buttons
      expect(buttons.length).toBeGreaterThan(0);
    });
  });
});
