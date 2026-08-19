# AI Proxy — Privacy and Logging Policy

**Scope:** `server/src/controllers/controllers.ts` — `ImproveProxy` and `TestPromptProxy`  
**Related issue:** #159

---

## Classification

| Data type | Classification | May appear in logs? |
|---|---|---|
| User-submitted prompt text | **Sensitive** | No |
| Model-generated response content | **Sensitive** | No |
| Upstream response body | **Sensitive** | No |
| Upstream error body | **Sensitive** | No |
| API keys / tokens | **Sensitive** | No |
| Email addresses / PII in prompts | **Sensitive** | No |
| Request correlation ID | Operational | Yes |
| Request size (bytes) | Operational | Yes |
| Response size (bytes) | Operational | Yes |
| Latency / duration (ms) | Operational | Yes |
| HTTP status code | Operational | Yes |
| Safe internal error code | Operational | Yes |

---

## Allowed Telemetry Fields

Application logs for proxy operations MUST contain only these fields:

```json
{
  "requestId":    "<uuid>",
  "durationMs":   <number>,
  "requestBytes": <number>,
  "responseBytes": <number>,
  "status":       <http-status-number>,
  "errorCode":    "<safe-code-string>"
}
```

**`errorCode` values** (closed set — never include free-form message text):

| Code | Meaning |
|---|---|
| `upstream_error` | Upstream service returned a non-2xx HTTP response |
| `proxy_exception` | An unexpected exception was thrown inside the proxy handler |
| `validation_error` | Request body failed input validation |

---

## Prohibited Content in Logs

The following MUST never appear in any log line, error event, or telemetry record:

- Full or partial prompt text submitted by users
- Model-generated response text
- Upstream response or error body content
- Raw exception messages that may echo prompt/model content
- Request or response headers (may contain auth tokens)
- Authentication tokens, API keys, cookies, or session identifiers
- Personally identifiable information (emails, names, wallet-associated data)

---

## Safe Error Handling Rules

1. **Upstream HTTP errors** — log `status` and `errorCode: "upstream_error"`. Never log or
   forward the upstream response body. Return a stable JSON envelope to the client:
   ```json
   { "error": "Upstream service error", "errorCode": "upstream_error" }
   ```

2. **Thrown exceptions** — log `errorCode: "proxy_exception"` and operational metadata only.
   Do NOT pass the `Error` object or its `.message` to the logger; the message may contain
   prompt text echoed by an upstream provider. Return to the client:
   ```json
   { "error": "Internal Server Error", "errorCode": "proxy_exception" }
   ```

3. **Validation failures** — log `errorCode: "validation_error"`. Return a safe, field-level
   error to the client without echoing any submitted content.

4. **Stack traces** MUST NOT be returned to clients in any environment.

---

## Implementation Notes

- All safe-logging helpers live in `server/src/utils/proxyLogger.ts`.
- `generateRequestId()` produces a per-request UUID correlation ID.
- `logProxySuccess()`, `logProxyUpstreamError()`, `logProxyException()` accept only the
  allowed metadata fields; they deliberately have no parameter for content strings.
- The `Error` object is never passed to any of these helpers.

---

## Log Retention and Access Control

- Proxy telemetry logs contain no sensitive data; standard log-pipeline retention applies
  (recommended: 30–90 days based on operational requirements).
- Restrict access to raw log streams to on-call engineers; do not expose logs in public
  dashboards or to untrusted third parties.
- If a centralized logging service (e.g. Sentry, Datadog) is configured, verify that
  breadcrumb/event capture is scoped to metadata fields only. Do not enable full
  request/response body capture for proxy routes.

---

## Testing

Privacy assertions live in `server/src/tests/proxyPrivacy.test.ts`.

The test suite verifies:

- **Case A** — successful requests: metadata present, raw prompt absent.
- **Case B** — upstream errors: upstream body absent from logs and client response.
- **Case C** — thrown exceptions: sensitive error text absent from logs and client response.
- **Case D** — secret/PII payloads: API keys, emails, tokens absent from all log lines.
- **Case E** — model responses: model output absent from all log lines.
- **Regression** — `requestId`, `durationMs`, `requestBytes`, `responseBytes`, `status`
  remain observable in logs; correct HTTP status codes preserved; successful proxy
  responses return upstream data unchanged.
