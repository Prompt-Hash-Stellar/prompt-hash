# Stellar configuration

Browser-safe Stellar values use the `PUBLIC_` prefix and are loaded by
`src/lib/env.ts`. The Node indexer validates the same deployment values at
startup through `server/src/config/stellar.ts`. Server secrets live in the
separate `server/src/config/secrets.ts` module; browser code must never import
that module or expose `MONGODB_URI`, challenge secrets, or private keys.

Use `.env.example` for development/testnet and `env.mainnet.example` for
mainnet. A deployment must set network, passphrase, RPC, Horizon, PromptHash
contract, native SAC, and (when simulation is used) the simulation account as
one consistent set. Invalid URLs and StrKeys fail startup instead of silently
falling back to a different network.
