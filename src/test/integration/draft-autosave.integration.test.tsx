import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CreatePromptForm } from "@/pages/sell/CreatePromptForm";
import { renderWithProviders } from "@/test/render";

const encryptPromptPlaintextMock = vi.fn();
const wrapPromptKeyMock = vi.fn();
const createPromptMock = vi.fn();

vi.mock("@/lib/env", () => ({
  unlockPublicKey: "unlock-public-key",
  stellarWalletNetwork: "TESTNET",
  stellarNetwork: "TESTNET",
}));

vi.mock("@/util/wallet", () => ({
  wallet: {
    signTransaction: vi.fn(),
    signMessage: vi.fn(),
  },
}));

vi.mock("@/lib/stellar/browserConfig", () => ({
  browserStellarConfig: {
    rpcUrl: "https://stellar.test/rpc",
    networkPassphrase: "Test SDF Network ; September 2015",
    allowHttp: false,
    promptHashContractId: "prompt-hash-contract",
    nativeAssetContractId: "native-asset-contract",
    simulationAccount: "GTESTSIMULATIONACCOUNT1234567890ABCDEFGH1234567890ABCD",
  },
}));

vi.mock("@/lib/crypto/promptCrypto", () => ({
  encryptPromptPlaintext: (...args: unknown[]) =>
    encryptPromptPlaintextMock(...args),
  wrapPromptKey: (...args: unknown[]) => wrapPromptKeyMock(...args),
}));

vi.mock("@/lib/stellar/promptHashClient", () => ({
  createPrompt: (...args: unknown[]) => createPromptMock(...args),
}));

vi.mock("@/components/ui/select", () => {
  return {
    Select: ({ children, onValueChange, value }: any) => (
      <select
        data-testid="mock-select"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {children}
      </select>
    ),
    SelectTrigger: ({ children }: any) => <>{children}</>,
    SelectValue: ({ placeholder }: any) => <>{placeholder}</>,
    SelectContent: ({ children }: any) => <>{children}</>,
    SelectItem: ({ value, children }: any) => (
      <option value={value}>{children}</option>
    ),
  };
});

const walletAddress = "GCREATORACCOUNT1234567890ABCDEFGH1234567890ABCDEFGH1234567890";
const storageKey = `prompt-hash:create-draft:${walletAddress}`;

describe("Creator prompt draft autosave and recovery integration tests", () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    const mockLocalStorage = {
      getItem: (key: string) => store[key] || null,
      setItem: (key: string, value: string) => {
        store[key] = value.toString();
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        for (const key in store) {
          delete store[key];
        }
      },
      length: 0,
      key: (index: number) => Object.keys(store)[index] || null,
    };
    Object.defineProperty(window, "localStorage", {
      value: mockLocalStorage,
      writable: true,
      configurable: true,
    });

    window.localStorage.clear();
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the restore prompt if a saved draft exists on mount, does not restore automatically, and allows restoring", async () => {
    const draftData = {
      formData: {
        title: "Saved Draft Title",
        priceXlm: "5",
        category: "Marketing",
      },
      savedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(storageKey, JSON.stringify(draftData));

    renderWithProviders(<CreatePromptForm />, {
      wallet: { address: walletAddress },
    });

    // Check that the restore prompt is visible
    expect(screen.getByText(/we found a saved draft from/i)).toBeInTheDocument();

    // The form field should not be populated yet (starts default)
    const titleInput = screen.getByLabelText(/title/i) as HTMLInputElement;
    expect(titleInput.value).toBe("");

    // Click Restore Draft
    fireEvent.click(screen.getByRole("button", { name: /restore draft/i }));

    // Verify fields populated
    expect(titleInput.value).toBe("Saved Draft Title");
    expect((screen.getByLabelText(/price in xlm/i) as HTMLInputElement).value).toBe("5");
    expect(screen.getByText(/draft restored from/i)).toBeInTheDocument();
  });

  it("discards the draft when clicking Discard on the restore prompt", async () => {
    const draftData = {
      formData: {
        title: "Saved Draft Title",
        priceXlm: "5",
      },
      savedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(storageKey, JSON.stringify(draftData));

    renderWithProviders(<CreatePromptForm />, {
      wallet: { address: walletAddress },
    });

    expect(screen.getByText(/we found a saved draft from/i)).toBeInTheDocument();

    // Click Discard
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));

    // Prompt is removed, local storage is cleared
    expect(screen.queryByText(/we found a saved draft from/i)).not.toBeInTheDocument();
    expect(window.localStorage.getItem(storageKey)).toBeNull();

    // Check title input is empty
    expect((screen.getByLabelText(/title/i) as HTMLInputElement).value).toBe("");
  });

  it("autosaves changed non-sensitive fields with debounce and ignores fullPrompt changes", async () => {
    renderWithProviders(<CreatePromptForm />, {
      wallet: { address: walletAddress },
    });

    const titleInput = screen.getByLabelText(/title/i);
    const fullPromptInput = screen.getByLabelText(/full prompt/i);

    // Modify title
    fireEvent.change(titleInput, { target: { value: "Autosave Title" } });
    
    // Modify sensitive full prompt
    fireEvent.change(fullPromptInput, { target: { value: "Secret Prompt Code" } });

    // Ensure it hasn't saved immediately
    expect(window.localStorage.getItem(storageKey)).toBeNull();

    // Fast-forward timers by 1 second
    vi.advanceTimersByTime(1000);

    // Verify draft is saved
    const savedRaw = window.localStorage.getItem(storageKey);
    expect(savedRaw).not.toBeNull();
    const saved = JSON.parse(savedRaw!);
    
    // Metadata should be saved
    expect(saved.formData.title).toBe("Autosave Title");
    // Secret plaintext content must NOT be saved
    expect(saved.formData.fullPrompt).toBeUndefined();
  });

  it("clears draft on successful submit and preserves it on failed transaction submit", async () => {
    vi.useRealTimers();
    encryptPromptPlaintextMock.mockResolvedValue({
      encryptedPrompt: "encrypted-prompt",
      encryptionIv: "encryption-iv",
      contentHash: "b".repeat(64),
      keyBytes: new Uint8Array([1, 2, 3, 4]),
    });
    wrapPromptKeyMock.mockResolvedValue("wrapped-key");

    // First try: submission will fail
    createPromptMock.mockRejectedValueOnce(new Error("Soroban Tx Failure"));

    renderWithProviders(<CreatePromptForm />, {
      wallet: {
        address: walletAddress,
        signTransaction: vi.fn().mockResolvedValue({}),
      },
    });

    // Populate fields
    fireEvent.change(screen.getByLabelText(/image url/i), { target: { value: "https://example.com/cover.png" } });
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Unique Submit Title" } });
    
    // Select category and description to pass validation
    fireEvent.change(screen.getByLabelText(/preview text/i), { target: { value: "Valid length preview text" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "Valid length description text" } });
    fireEvent.change(screen.getByLabelText(/full prompt/i), { target: { value: "Valid length full prompt content" } });

    // Select category
    fireEvent.change(screen.getByTestId("mock-select"), { target: { value: "Marketing" } });

    // Wait for autosave to run
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(window.localStorage.getItem(storageKey)).not.toBeNull();

    // Submit form (fails)
    const submitButton = screen.getByRole("button", { name: /create prompt listing/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/soroban tx failure/i)).toBeInTheDocument();
    });

    // Draft should still exist
    expect(window.localStorage.getItem(storageKey)).not.toBeNull();

    // Second try: submission succeeds
    createPromptMock.mockResolvedValueOnce({ promptId: 100n });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/created successfully/i)).toBeInTheDocument();
    });

    // Draft should be cleared
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });
});
