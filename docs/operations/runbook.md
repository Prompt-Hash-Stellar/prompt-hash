# Runbook: Operating Unlock Services

## Monitoring & Metrics

We use structured logging to emit metrics. Key metrics to monitor:

- `challenge_issued_total`: Volume of unlock requests initiated.
- `unlock_success_total`: Successful prompt decryptions.
- `unlock_failure_total`: Failed attempts (labeled by reason).
- `rate_limit_hit_total`: Blocked requests (labeled by type).
- `api_request_duration_ms`: Latency of the unlock flow.

## Health Checks
The `/api/health` endpoint provides a basic signal of service availability.

## Rate Limiting Configuration
Default limits (defined in `src/lib/observability/rateLimiter.ts`):
- **Challenge**: 10 requests per minute per IP.
- **Unlock**: 5 requests per minute per IP/Wallet.

## Redaction Rules
The following fields are automatically redacted from logs:
- `plaintext`
- `secret`
- `privateKey`
- `signedMessage`
- Authorization headers

## Debugging Common Issues

### "Invalid wallet signature"
- Ensure the user's wallet is signing the exact message returned by the challenge endpoint.
- Verify that the nonce hasn't expired (default TTL: 5 minutes).

### "Prompt access has not been purchased"
- Check if the transaction for purchasing the prompt has been confirmed on the Stellar network.
- Ensure the indexer or RPC being used is up to date with the latest ledger.

---

## Secret Rotation

See [docs/secret-rotation.md](../secret-rotation.md) for the full rotation guide. This section is the operational quick-reference.

### When to rotate

- **Scheduled**: every 30–90 days via cron (`scripts/cron-rotation.example`).
- **Unscheduled**: immediately on suspected compromise or relevant personnel change.

### Pre-rotation checklist

```bash
# Confirm required env vars are present on the server
echo "CHALLENGE_TOKEN_SECRET set: ${CHALLENGE_TOKEN_SECRET:+yes}"
echo "ADMIN_ROTATION_TOKEN set  : ${ADMIN_ROTATION_TOKEN:+yes}"
echo "UNLOCK_SERVICE_URL        : ${UNLOCK_SERVICE_URL:-NOT SET}"

# Dry-run — validate all preflight checks without mutating state
./scripts/rotate-secrets.sh --dry-run --env production
```

The dry-run must report `preflightOk: true` before proceeding with a real rotation.

### Performing rotation

```bash
# Via script (recommended) — 10-minute grace period for production
./scripts/rotate-secrets.sh --grace-period 600 --env production

# Via API directly
curl -X POST "${UNLOCK_SERVICE_URL}/api/auth/rotateSecret" \
  -H "Authorization: Bearer ${ADMIN_ROTATION_TOKEN}" \
  -H "Content-Type: application/json"
```

### Post-rotation verification

```bash
# 1. Health check
curl -s "${UNLOCK_SERVICE_URL}/api/health" | jq '.'

# 2. Request a new challenge token — must succeed with the new secret
curl -s -X POST "${UNLOCK_SERVICE_URL}/api/auth/challenge" \
  -H "Content-Type: application/json" \
  -d '{"walletAddress": "GTEST..."}' | jq '.'

# 3. Monitor structured logs for:
#    event=secret_rotation_success (expected)
#    event=secret_rotation_error   (alert immediately)
```

### Rollback — within grace period

If the new secret causes problems while the previous secret is still valid:

```bash
# Restore the previous secret as current
export CHALLENGE_TOKEN_SECRET="$CHALLENGE_TOKEN_SECRET_PREVIOUS"
unset CHALLENGE_TOKEN_SECRET_PREVIOUS
unset CHALLENGE_TOKEN_ROTATION_TIMESTAMP

# Restart the service
systemctl restart unlock-service

# Verify
curl -s "${UNLOCK_SERVICE_URL}/api/health" | jq '.'
```

### Rollback — grace period has expired

1. Retrieve the previous secret value from your secrets manager (AWS Secrets Manager, Vault, etc.).
2. Restore it as `CHALLENGE_TOKEN_SECRET` and restart the service.
3. If the previous value is unrecoverable, rotate again immediately. In-flight tokens (max 5-min TTL) will fail; users must re-request a challenge.

### Emergency rotation (suspected compromise)

Immediately invalidate all active tokens by setting the grace period to 0:

```bash
./scripts/rotate-secrets.sh --grace-period 0 --env production
```

Then verify with the health check and notify the security team.

### Troubleshooting

| Symptom | Likely cause | Resolution |
|---|---|---|
| Script exits before making a request | Preflight error (missing/bad env var) | Read script output; fix reported env var and retry |
| HTTP 401 from endpoint | Wrong `ADMIN_ROTATION_TOKEN` | Verify value matches server-side config |
| HTTP 422 from endpoint | Server preflight failure | Read `details` in response; fix server env |
| Unlock failures spike after rotation | Grace period too short | Increase `CHALLENGE_TOKEN_GRACE_PERIOD_MS`; roll back if within grace window |
| `CHALLENGE_TOKEN_SECRET_PREVIOUS` still set days later | Cleanup not running | `unset CHALLENGE_TOKEN_SECRET_PREVIOUS CHALLENGE_TOKEN_ROTATION_TIMESTAMP` and restart |
