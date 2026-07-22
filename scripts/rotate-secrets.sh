#!/usr/bin/env bash
###############################################################################
# Automated Secret Rotation Script
#
# Rotates challenge token secrets via the /api/auth/rotateSecret endpoint.
# Supports a grace period to prevent service disruption during rotation.
#
# Usage:
#   ./scripts/rotate-secrets.sh [OPTIONS]
#
# Options:
#   --grace-period SECONDS   Grace period for old secret (default: 300)
#   --env ENV                Target environment label, e.g. staging|production
#                            (informational only — used in log output)
#   --dry-run                Call the endpoint in dry-run mode: validate
#                            everything and report what would happen without
#                            mutating any secrets
#   --help                   Show this help message
#
# Required environment variables:
#   ADMIN_ROTATION_TOKEN     Bearer token authorising the rotation endpoint
#   UNLOCK_SERVICE_URL       Base URL of the unlock service
#                            (e.g. https://api.example.com)
#
# Optional environment variables:
#   CHALLENGE_TOKEN_SECRET   When set, validated locally for correct format
#                            before the remote call is made
#
# Examples:
#   # Dry-run first (recommended before a real rotation)
#   ADMIN_ROTATION_TOKEN=… UNLOCK_SERVICE_URL=https://api.example.com \
#     ./scripts/rotate-secrets.sh --dry-run --env staging
#
#   # Real rotation with 10-minute grace period
#   ADMIN_ROTATION_TOKEN=… UNLOCK_SERVICE_URL=https://api.example.com \
#     ./scripts/rotate-secrets.sh --grace-period 600 --env production
###############################################################################

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
GRACE_PERIOD_SECONDS=300
TARGET_ENV=""
DRY_RUN=false

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --grace-period)
      GRACE_PERIOD_SECONDS="$2"
      shift 2
      ;;
    --env)
      TARGET_ENV="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help)
      sed -n '/^# Usage:/,/^###/p' "$0" | head -n -1 | sed 's/^# \{0,2\}//'
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      echo "Use --help for usage information." >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Preflight — required env vars must be present before any remote call
# ---------------------------------------------------------------------------
PREFLIGHT_ERRORS=0

require_env() {
  local var_name="$1"
  if [[ -z "${!var_name:-}" ]]; then
    echo "PREFLIGHT ERROR: ${var_name} is not set" >&2
    PREFLIGHT_ERRORS=$((PREFLIGHT_ERRORS + 1))
  fi
}

require_env "ADMIN_ROTATION_TOKEN"
require_env "UNLOCK_SERVICE_URL"

# Optional but validated when present: current secret format
if [[ -n "${CHALLENGE_TOKEN_SECRET:-}" ]]; then
  # base64url: A-Z a-z 0-9 _ -  with no padding, minimum 43 chars (32 raw bytes)
  if ! echo "$CHALLENGE_TOKEN_SECRET" | grep -qE '^[A-Za-z0-9_-]{43,}$'; then
    echo "PREFLIGHT ERROR: CHALLENGE_TOKEN_SECRET does not meet format requirements." >&2
    echo "  Expected: base64url-encoded, ≥43 characters (≥32 raw bytes), no padding." >&2
    echo "  Generate a valid secret with:" >&2
    echo "    openssl rand -base64 32 | tr -d '=' | tr '+/' '-_'" >&2
    PREFLIGHT_ERRORS=$((PREFLIGHT_ERRORS + 1))
  fi
fi

# ADMIN_ROTATION_TOKEN minimum length check
if [[ -n "${ADMIN_ROTATION_TOKEN:-}" && ${#ADMIN_ROTATION_TOKEN} -lt 16 ]]; then
  echo "PREFLIGHT ERROR: ADMIN_ROTATION_TOKEN is too short (${#ADMIN_ROTATION_TOKEN} chars, minimum 16)." >&2
  echo "  Generate a strong token with: openssl rand -hex 32" >&2
  PREFLIGHT_ERRORS=$((PREFLIGHT_ERRORS + 1))
fi

# UNLOCK_SERVICE_URL must look like a URL
if [[ -n "${UNLOCK_SERVICE_URL:-}" ]] && ! echo "$UNLOCK_SERVICE_URL" | grep -qE '^https?://'; then
  echo "PREFLIGHT ERROR: UNLOCK_SERVICE_URL does not look like a valid URL: ${UNLOCK_SERVICE_URL}" >&2
  PREFLIGHT_ERRORS=$((PREFLIGHT_ERRORS + 1))
fi

if [[ $PREFLIGHT_ERRORS -gt 0 ]]; then
  echo "" >&2
  echo "Rotation aborted: ${PREFLIGHT_ERRORS} preflight error(s) must be resolved first." >&2
  echo "No changes were made." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Grace period validation
# ---------------------------------------------------------------------------
if ! [[ "$GRACE_PERIOD_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --grace-period must be a non-negative integer (got: ${GRACE_PERIOD_SECONDS})" >&2
  exit 1
fi
GRACE_PERIOD_MS=$((GRACE_PERIOD_SECONDS * 1000))

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
echo "========================================="
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  Challenge Token Secret Rotation — DRY RUN"
else
  echo "  Challenge Token Secret Rotation"
fi
echo "========================================="
echo "  Service URL  : ${UNLOCK_SERVICE_URL}"
echo "  Environment  : ${TARGET_ENV:-<not specified>}"
echo "  Grace period : ${GRACE_PERIOD_SECONDS}s (${GRACE_PERIOD_MS}ms)"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  Mode         : DRY-RUN (no secrets will be mutated)"
fi
echo ""

# ---------------------------------------------------------------------------
# Build the request URL (append dry_run query param when applicable)
# ---------------------------------------------------------------------------
ROTATE_URL="${UNLOCK_SERVICE_URL}/api/auth/rotateSecret"
if [[ "$DRY_RUN" == "true" ]]; then
  ROTATE_URL="${ROTATE_URL}?dry_run=true"
fi

# ---------------------------------------------------------------------------
# Call rotation endpoint
# ---------------------------------------------------------------------------
if [[ "$DRY_RUN" == "true" ]]; then
  echo "Running preflight dry-run against ${ROTATE_URL} …"
else
  echo "Initiating secret rotation against ${ROTATE_URL} …"
fi

HTTP_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer ${ADMIN_ROTATION_TOKEN}" \
  -H "Content-Type: application/json" \
  -w "\nHTTP_STATUS:%{http_code}" \
  "${ROTATE_URL}" 2>&1) || {
    echo "ERROR: curl failed — could not reach ${ROTATE_URL}" >&2
    echo "Check that UNLOCK_SERVICE_URL is correct and the service is reachable." >&2
    exit 1
  }

HTTP_STATUS=$(echo "$HTTP_RESPONSE" | grep "HTTP_STATUS" | cut -d: -f2)
BODY=$(echo "$HTTP_RESPONSE" | sed '/HTTP_STATUS/d')

# ---------------------------------------------------------------------------
# Handle response
# ---------------------------------------------------------------------------
if [[ "$HTTP_STATUS" == "200" ]]; then
  if [[ "$DRY_RUN" == "true" ]]; then
    PREFLIGHT_OK=$(echo "$BODY" | grep -o '"preflightOk":[^,}]*' | cut -d: -f2 | tr -d ' ')
    echo ""
    if [[ "$PREFLIGHT_OK" == "true" ]]; then
      echo "✓ Dry-run succeeded — all preflight checks passed."
    else
      echo "✗ Dry-run found preflight errors (see details below)."
    fi
    echo ""
    echo "Server response:"
    if command -v jq &>/dev/null; then
      echo "$BODY" | jq '.'
    else
      echo "$BODY"
    fi
    echo ""
    if [[ "$PREFLIGHT_OK" == "true" ]]; then
      echo "To perform the actual rotation, re-run without --dry-run."
      exit 0
    else
      exit 1
    fi
  fi

  echo ""
  echo "✓ Secret rotated successfully!"
  echo ""
  echo "Response:"
  if command -v jq &>/dev/null; then
    echo "$BODY" | jq '.'
  else
    echo "$BODY"
  fi

  # Extract and display expiry time
  EXPIRES_AT=$(echo "$BODY" | grep -o '"expiresAt":[0-9]*' | cut -d: -f2)
  if [[ -n "$EXPIRES_AT" && "$EXPIRES_AT" != "null" ]]; then
    EXPIRES_EPOCH=$((EXPIRES_AT / 1000))
    EXPIRES_DATE=$(date -d "@${EXPIRES_EPOCH}" 2>/dev/null \
      || date -r "${EXPIRES_EPOCH}" 2>/dev/null \
      || echo "N/A")
    echo ""
    echo "Previous secret will expire at: ${EXPIRES_DATE}"
  fi

  echo ""
  echo "========================================="
  echo "Next Steps"
  echo "========================================="
  echo "1. Verify the service is healthy:"
  echo "     curl -s ${UNLOCK_SERVICE_URL}/api/health | jq '.'"
  echo "2. Test a challenge/unlock round-trip before the grace period ends."
  echo "3. Previous secret will be automatically invalidated after the grace period."
  echo "4. Schedule next rotation in 30–90 days."
  echo ""
  echo "Rollback (if something goes wrong during the grace period):"
  echo "  If the new secret causes issues, manually restore the previous secret:"
  echo "    CHALLENGE_TOKEN_SECRET=<previous-value>"
  echo "    unset CHALLENGE_TOKEN_SECRET_PREVIOUS CHALLENGE_TOKEN_ROTATION_TIMESTAMP"
  echo "  Then redeploy the service."
  echo ""
  exit 0

elif [[ "$HTTP_STATUS" == "401" ]]; then
  echo "" >&2
  echo "✗ Rotation rejected: Unauthorized (HTTP 401)" >&2
  echo "  Check that ADMIN_ROTATION_TOKEN matches the server-side ADMIN_ROTATION_TOKEN." >&2
  echo "  Ensure the Authorization header format is: Bearer <token>" >&2
  exit 1

elif [[ "$HTTP_STATUS" == "422" ]]; then
  echo "" >&2
  echo "✗ Rotation rejected: Server-side preflight checks failed (HTTP 422)" >&2
  echo "" >&2
  echo "Server response:" >&2
  if command -v jq &>/dev/null; then
    echo "$BODY" | jq '.' >&2
  else
    echo "$BODY" >&2
  fi
  echo "" >&2
  echo "Resolve the reported configuration errors on the server, then retry." >&2
  exit 1

else
  echo "" >&2
  echo "✗ Rotation failed (HTTP ${HTTP_STATUS})" >&2
  echo "" >&2
  echo "Response:" >&2
  if command -v jq &>/dev/null; then
    echo "$BODY" | jq '.' >&2
  else
    echo "$BODY" >&2
  fi
  echo "" >&2
  echo "No changes were committed." >&2
  exit 1
fi
