# Indexed prompt search

`GET /api/search/indexed` searches only the public projection: title, category,
280-character public preview, tags, creator, active state, and source ledger.
Plaintext prompt content is never copied to or returned by this index.

Parameters: `q`, `category`, `tag`, `creator`, `limit` (max 50), and the opaque
`cursor` returned by the previous response. Ordering is stable by creation time
and id. Invalid cursors return 400. `staleAtLedger` exposes the oldest source
ledger represented in the response so clients can communicate index freshness.
