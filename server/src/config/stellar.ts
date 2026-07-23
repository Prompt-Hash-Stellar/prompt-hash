import { z } from "zod";

const contractId = z.string().regex(/^C[A-Z2-7]{55}$/, "must be a Stellar contract StrKey");
const accountId = z.string().regex(/^G[A-Z2-7]{55}$/, "must be a Stellar account StrKey");

const schema = z.object({
  PUBLIC_STELLAR_NETWORK: z.enum(["TESTNET", "PUBLIC", "FUTURENET", "LOCAL", "STANDALONE"]),
  PUBLIC_STELLAR_NETWORK_PASSPHRASE: z.string().min(1),
  PUBLIC_STELLAR_RPC_URL: z.string().url(),
  PUBLIC_STELLAR_HORIZON_URL: z.string().url(),
  PUBLIC_PROMPT_HASH_CONTRACT_ID: contractId,
  PUBLIC_STELLAR_NATIVE_ASSET_CONTRACT_ID: contractId,
  PUBLIC_STELLAR_SIMULATION_ACCOUNT: accountId.optional(),
});

export type StellarServerConfig = z.infer<typeof schema>;

export function loadStellarConfig(source: NodeJS.ProcessEnv = process.env): StellarServerConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid Stellar configuration: ${details}`);
  }
  return Object.freeze(parsed.data);
}
