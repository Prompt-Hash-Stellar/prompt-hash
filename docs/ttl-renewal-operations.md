# TTL Renewal Operations

## Overview
Soroban requires state entries to have a TTL (Time To Live). If the TTL reaches 0, the entry is archived.
To prevent critical state (like the Contract Instance configuration or important Admin policies) from being archived, this project includes a deploy-time TTL readiness check.

## Thresholds
- **Critical Threshold**: 7 days (120,960 ledgers)
- **Bump Amount**: 30 days (518,400 ledgers)

If the contract's instance TTL falls below 7 days, the deployment pipeline (`deploy.yml`) will fail the `check-ttl` job and prevent releasing a new version of the contract.

## Remediation Commands
If the deploy check fails because critical state is expiring soon, you must run the following command to bump the TTL manually before re-triggering the deployment:

```bash
# Bump the instance TTL directly using Soroban CLI
soroban contract bump --id <CONTRACT_ID> --network <NETWORK> --source admin --ledgers-to-expire 518400
```

Once the instance TTL is bumped above the 7-day threshold, the `check-ttl` job will pass, and the contract release can proceed.
