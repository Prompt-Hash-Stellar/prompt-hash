# Challenge Token Secret Rotation

## Overview

The unlock service uses HMAC-signed challenge tokens to authenticate wallet ownership before decrypting purchased prompt content. The signing secret must be rotated periodically to limit exposure. This document describes the rotation mechanism, how to operate it safely, and what to do when something goes wrong.

## Architecture

### Multi-Secret Support

The system supports multiple active secrets simultaneously during a configurable grace period. This prevents service disruption during rotation:

1. **Current Secret** — the primary secret used to sign new challenge tokens.
2. **Previous Secret** — the old secret, valid during the grace period for tokens already in flight.
3. **Grace Period** — time window (default 5 minutes) where both secrets are accepted.

### Token Verification Flow

```
1. Client requests challenge token
   ↓
2. Server signs token with CURRENT secret
   ↓
3. Client signs challenge message with wallet
   ↓
4. Client submits unlock request with signed token
   ↓
5. Server verifies token against [CURRENT, PREVIOUS] secrets
   ↓
6. If valid with either secret → proceed with unlock
```

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `CHALLENGE_TOKEN_SECRET` | Current active secret for signing tokens. Must be ≥32-byte base64url. |
| `ADMIN_ROTATION_TOKEN` | Bearer token that authorises the rotation endpoint. Must be ≥16 chars. |

### Rotation State (managed automatically)

| Variable | Description |
|---|---|
| `CHALLENGE_TOKEN_SECRET_PREVIOUS` | Previous secret (valid during grace period). |
| `CHALLENGE_TOKEN_ROTATION_TIMESTAMP` | Unix timestamp (ms) of the last rotation. |
| `CHALLENGE_TOKEN_GRACE_PERIOD_MS` | Grace period duration in ms (default: `300000` = 5 min). |

## Preflight Checks

All rotation paths (script and API endpoint) run preflight checks **before mutating any state**. Rotation is aborted if any check fails. Checked items:

- `CHALLENGE_TOKEN_SECRET` is set, not a placeholder, and ≥43 base64url characters (≥32 raw bytes).
- `ADMIN_ROTATION_TOKEN` is set, not a placeholder, and ≥16 characters.
- `UNLOCK_SERVICE_URL` looks like a valid URL (script only).
- Previous-secret env vars are not stale beyond the grace period (warning, not error).

## Rotation Methods

### 1. Script with Dry-Run (Recommended)

Always run `--dry-run` first to confirm the server would accept rotation:

```bash
export ADMIN_ROTATION_TOKEN="your-secure-admin-token"
export UNLOCK_SERVICE_URL="https://your-domain.com"

# Step 1: dry-run — no secrets are mutated
./scripts/rotate-secrets.sh --dry-run --env staging

# Step 2: real rotation with 10-minute grace period
./scripts/rotate-secrets.sh --grace-period 600 --env production
```

`--dry-run` calls the endpoint with `?dry_run=true`, which runs all server-side preflight checks and returns a description of what would happen — nothing is written or changed.

#### Cron Setup

```bash
cp scripts/cron-rotation.example /etc/cron.d/prompt-hash-rotation
sudo nano /etc/cron.d/prompt-hash-rotation   # set your paths and schedule
```

Example schedule (rotate every 30 days at 02:00 UTC):

```
0 2 1 * * /path/to/scripts/rotate-secrets.sh --grace-period 600 --env production >> /var/log/secret-rotation.log 2>&1
```

### 2. Manual Rotation via API

```bash
# Dry-run first
curl -X POST "https://your-domain.com/api/auth/rotateSecret?dry_run=true" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json"

# Real rotation
curl -X POST "https://your-domain.com/api/auth/rotateSecret" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json"
```

**Success response (200):**
```json
{
  "success": true,
  "message": "Secret rotated successfully",
  "rotationTimestamp": 1714567200000,
  "gracePeriodMs": 300000,
  "expiresAt": 1714567500000,
  "nextStep": "Verify the service is healthy: GET /api/health — then test a challenge/unlock round-trip before the grace period expires."
}
```

**Preflight failure response (422):**
```json
{
  "error": "Preflight checks failed — rotation aborted",
  "details": [
    "CHALLENGE_TOKEN_SECRET does not meet format requirements (need ≥32-byte base64url, got 8 chars)."
  ],
  "warnings": []
}
```

### 3. Manual Rotation via Environment Update

For deployments without API access:

```bash
# 1. Generate a new secret
NEW_SECRET=$(openssl rand -base64 32 | tr -d '=' | tr '+/' '-_')

# 2. Validate format (must match base64url, ≥43 chars)
echo "$NEW_SECRET" | grep -qE '^[A-Za-z0-9_-]{43,}$' && echo "Format OK" || echo "INVALID"

# 3. Rotate environment variables
export CHALLENGE_TOKEN_SECRET_PREVIOUS="$CHALLENGE_TOKEN_SECRET"
export CHALLENGE_TOKEN_SECRET="$NEW_SECRET"
export CHALLENGE_TOKEN_ROTATION_TIMESTAMP=$(date +%s000)
export CHALLENGE_TOKEN_GRACE_PERIOD_MS=300000

# 4. Restart service
systemctl restart unlock-service

# 5. Verify service health
curl -s https://your-domain.com/api/health | jq '.'

# 6. After grace period — clean up the previous secret
unset CHALLENGE_TOKEN_SECRET_PREVIOUS
unset CHALLENGE_TOKEN_ROTATION_TIMESTAMP
```

## Verification After Rotation

After every rotation — automated or manual — run these checks:

```bash
# 1. Health check
curl -s "${UNLOCK_SERVICE_URL}/api/health" | jq '.'

# 2. Request a challenge token (should succeed with new secret)
curl -s -X POST "${UNLOCK_SERVICE_URL}/api/auth/challenge" \
  -H "Content-Type: application/json" \
  -d '{"walletAddress": "GTEST..."}' | jq '.'

# 3. Watch logs for verification errors during grace period
# Expect: event=secret_rotation_success in structured logs
# Alert on: event=secret_rotation_error or spike in unlock_failure_total
```

## Rollback Steps

If the rotation causes issues (token failures, broken unlock flow), roll back within the grace period:

### Rollback via environment (grace period still active)

```bash
# Restore the previous secret as the current one
export CHALLENGE_TOKEN_SECRET="$CHALLENGE_TOKEN_SECRET_PREVIOUS"
unset CHALLENGE_TOKEN_SECRET_PREVIOUS
unset CHALLENGE_TOKEN_ROTATION_TIMESTAMP

# Restart the service
systemctl restart unlock-service

# Verify
curl -s "${UNLOCK_SERVICE_URL}/api/health" | jq '.'
```

### Rollback after grace period has expired

If the grace period has elapsed and you no longer have the previous secret value:

1. Check your secrets manager (AWS Secrets Manager, Vault, etc.) for the last stored version.
2. Restore the previous version and restart.
3. If the previous value is unrecoverable, rotate again immediately — existing in-flight tokens (max 5-minute TTL) will fail; users can simply re-request a challenge.

### Emergency rotation (suspected compromise)

Force immediate invalidation of all active tokens by setting the grace period to 0:

```bash
# Script
./scripts/rotate-secrets.sh --grace-period 0 --env production

# API
curl -X POST "https://your-domain.com/api/auth/rotateSecret" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -d '{}' \
  -H "Content-Type: application/json"
# Then update CHALLENGE_TOKEN_GRACE_PERIOD_MS=0 on the server before restarting
```

All existing challenge tokens are immediately invalid. Users must re-request a new challenge.

## Rotation Schedule Recommendations

| Security Level | Frequency | Grace Period | Use Case |
|---|---|---|---|
| **High** | Weekly | 5 min | Financial applications, sensitive data |
| **Standard** | Monthly (30 days) | 10 min | General production use |
| **Moderate** | Quarterly (90 days) | 15 min | Low-risk applications |

Factors to consider: traffic volume, token TTL (default 5 min), compliance requirements, on-call capacity.

## Monitoring and Alerting

### Structured log events to watch

| Event | Level | Meaning |
|---|---|---|
| `secret_rotation_success` | info | Rotation completed |
| `secret_rotation_dry_run` | info | Dry-run called (check `preflightOk`) |
| `secret_rotation_preflight_failed` | error | Rotation rejected; see `errors` field |
| `secret_rotation_error` | error | Unexpected error during rotation |
| `secret_rotation_previous_secret_expired` | info | Grace period cleanup complete |
| `secret_rotation_unauthorized` | warn | Invalid or missing admin token used |
| `secret_rotation_admin_token_missing` | error | Server not configured for rotation |
| `secret_rotation_store_stub` | warn | Using in-memory stub — not for production |

### Key metrics

- `unlock_failure_total` — a spike immediately after rotation means the grace period is too short.
- `challenge_issued_total` — should remain stable after rotation.

## Security Best Practices

### Secret generation

Always use a cryptographically secure generator:

```bash
# Recommended — 32 raw bytes, base64url, no padding
openssl rand -base64 32 | tr -d '=' | tr '+/' '-_'
```

Never use weak or human-readable values.

### Secret storage

| Environment | Recommended storage |
|---|---|
| Development | `.env` files (never commit) |
| Staging / Production | AWS Secrets Manager, HashiCorp Vault, Azure Key Vault, Google Secret Manager |

**Never** hardcode secrets in source code, commit them to version control, log them in plaintext, or share them over insecure channels.

### Access control

- Limit the rotation endpoint to authorised operators only.
- Use a strong `ADMIN_ROTATION_TOKEN` (≥32 hex characters).
- Rotate the admin token separately from the challenge secrets.
- Audit all rotation attempts via structured logs.

## Production Deployment Checklist

- [ ] Generate strong initial secret: `openssl rand -base64 32 | tr -d '=' | tr '+/' '-_'`
- [ ] Store in a secrets manager, not directly in environment config files
- [ ] Configure `ADMIN_ROTATION_TOKEN` (≥32 hex chars)
- [ ] Run `--dry-run` against staging and confirm `preflightOk: true`
- [ ] Set up cron or systemd timer using `scripts/cron-rotation.example`
- [ ] Configure log aggregation to capture structured rotation events
- [ ] Set up alerting on `secret_rotation_error` and `secret_rotation_preflight_failed`
- [ ] Test full rollback procedure in staging before first production rotation
- [ ] Document recovery contacts in operations runbook

## API Reference

### POST /api/auth/rotateSecret

Rotate the challenge token signing secret.

**Authentication:** `Authorization: Bearer <ADMIN_ROTATION_TOKEN>`

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `dry_run` | `true` \| `1` | Optional. Run preflight only; do not mutate state. |

**Response (200 OK — success):**
```json
{
  "success": true,
  "message": "Secret rotated successfully",
  "rotationTimestamp": 1714567200000,
  "gracePeriodMs": 300000,
  "expiresAt": 1714567500000,
  "nextStep": "Verify the service is healthy: GET /api/health …"
}
```

**Response (200 OK — dry-run):**
```json
{
  "dryRun": true,
  "preflightOk": true,
  "errors": [],
  "warnings": [],
  "description": [
    "DRY-RUN: rotation would proceed as follows:",
    "  1. Generate new 32-byte base64url secret",
    "..."
  ]
}
```

**Response (401 Unauthorized):**
```json
{ "error": "Unauthorized" }
```

**Response (422 Unprocessable Entity — preflight failed):**
```json
{
  "error": "Preflight checks failed — rotation aborted",
  "details": ["CHALLENGE_TOKEN_SECRET does not meet format requirements …"],
  "warnings": []
}
```

**Response (500 Internal Server Error):**
```json
{ "error": "Rotation is not configured on this server. Set ADMIN_ROTATION_TOKEN." }
```

## Related Documentation

- [Security Model](./security-model.md) — overall security architecture
- [API Reference](./api-reference.md) — challenge-response protocol
- [Operations Runbook](./operations/runbook.md) — operational procedures and incident response
