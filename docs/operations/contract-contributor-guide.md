# Contract Contributor Guide

This guide provides step-by-step instructions for contributors who want to
modify the **prompt-hash** Soroban contract. The contract lives in
`contracts/prompt-hash` and is written in Rust. Because the contract is
deployed to the Stellar network, changes can have a large impact on
marketplace invariants.

This guide covers:

- Toolchain requirements and contract test commands
- Running the full test suite locally
- Deploying to testnet and capturing the deployed contract ID
- Reviewing storage and schema changes
- A checklist for preserving access rights, fee routing, and purchase records
- Links to maintainer-only deployment and upgrade documentation

## Toolchain

The repository uses the Rust toolchain specified in `rust-toolchain.toml`.

Install the required Rust toolchain:

```bash
rustup toolchain install stable
rustup default stable
```

Install the Soroban CLI:

```bash
cargo install --locked soroban-cli
```

## Running Tests

The contract tests are located under `contracts/prompt-hash`.

Run the complete workspace tests:

```bash
cargo test --workspace --all-features
```

To test only the Prompt Hash contract:

```bash
cargo test -p prompt-hash --all-features
```

If a test fails, review the test output and stack trace to identify the failing assertion before making changes.

## Deploying to Testnet

The repository provides `scripts/deploy.sh` to build, deploy, initialize, and verify the contract.

### Configure the deployment environment

Before deploying:

- Ensure the Rust and Soroban toolchains are installed.
- By default, the deployment script targets **testnet**.
- To deploy elsewhere, set the `NETWORK` environment variable.
- Optionally configure `ADMIN_ALIAS` and `FEE_WALLET_ALIAS`. The deployment script creates and funds these identities automatically on supported development networks.

Example:

```bash
export NETWORK=testnet
./scripts/deploy.sh
```

After deployment:

- Record the printed contract ID.
- Verify that `.env` and `.env.local` were updated with the generated `PUBLIC_PROMPT_HASH_CONTRACT_ID` and related network configuration.

## Storage / Schema Changes

When modifying contract storage:

```bash
cargo run --bin schema-diff -- --old <old-contract-id> --new <new-contract-id>
```

Review the schema differences carefully to ensure existing on-chain state remains compatible.

## Review Checklist

Before opening a pull request, verify that:

- Access-control rules remain unchanged unless intentionally modified.
- Fee-routing logic still sends fees to the correct destination.
- Existing purchase records remain readable and compatible.
- Storage changes preserve backwards compatibility.
- `scripts/upgrade.sh` completes successfully on a development or test network.

## Maintainer-Only Steps

The following tasks should only be performed by project maintainers:

- Production deployments documented in `docs/operations/mainnet-deployment.md`.
- Contract upgrade procedures documented in `docs/operations/contract-upgrades.md`.

---

For additional operational details, see:

- `docs/operations/contract-upgrades.md`
- `docs/operations/mainnet-deployment.md`