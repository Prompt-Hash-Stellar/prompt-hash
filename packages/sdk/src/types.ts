/** SDK configuration — Issue #110 */

export interface ClientConfig {
  /** PromptHash backend API base URL */
  apiUrl: string;
  /** Stellar network: "testnet" | "mainnet" */
  network?: "testnet" | "mainnet";
}

export interface ContractClientConfig {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
}

export interface PromptInfo {
  id: string;
  title: string;
  image: string;
  rating: number;
  upvotes: number;
  owner: string;
  priceUSDC?: number;
}

export interface PurchaseResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

export interface VoteResult {
  success: boolean;
  upvotes: number;
}

export interface RevenueSplit {
  recipient: string;
  bps: number;
}

export interface ListingConfig {
  price: bigint;
  asset: string;
  max_supply: bigint;
  expires_at: bigint;
  splits: RevenueSplit[];
  tags: string[];
}

export interface CreatePromptArgs {
  creator: string;
  imageUrl: string;
  title: string;
  category: string;
  previewText: string;
  encryptedPrompt: string;
  encryptionIv: string;
  wrappedKey: string;
  contentHash: Buffer;
  listing: ListingConfig;
}

export interface ContractPrompt {
  id: bigint;
  creator: string;
  image_url: string;
  title: string;
  category: string;
  preview_text: string;
  encrypted_prompt: string;
  encryption_iv: string;
  wrapped_key: string;
  content_hash: Buffer;
  price_stroops: bigint;
  asset: string;
  active: boolean;
  sales_count: bigint;
  max_supply: bigint;
  expires_at: bigint;
  splits: RevenueSplit[];
  revision: number;
  tags: string[];
}
