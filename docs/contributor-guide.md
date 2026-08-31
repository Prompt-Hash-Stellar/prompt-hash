# Contributor Guide

This guide is the source of truth for two things:

1. the **domain verification rubric** — how a reward reviewer decides whether a
   contribution in each domain is complete, and
2. the **maintainer review checklist** — what a maintainer does before approving a PR.

Every hard issue is expected to pick one rubric domain, so the reviewer knows
which columns apply. The template at `.github/ISSUE_TEMPLATE/hard-issue.yml`
asks for the domain explicitly.

Local setup lives in `docs/contributing.md`; this file only covers what "done"
means.

---

## Verification Rubric

Each domain lists the evidence a reward reviewer must see before a task is
considered complete. "Required" columns are gating; "Preferred" columns earn
extra credit but do not block review.

#### Frontend / UI

| Evidence | Standard | Column |
| :--- | :--- | :--- |
| Behaviour test | Vitest suite covers the new interaction, including the failing case described in the issue | Required |
| Type safety | `npm run typecheck` passes with no new errors | Required |
| Screenshots | Before/after screenshots of the affected screen in light and dark theme | Required |
| Responsive | Screenshot at 375px and 1440px width, or a note explaining why the screen is not responsive | Preferred |
| Accessibility | `aria-label` or `role` on any new interactive element; no keyboard-only dead ends | Preferred |
| Regression guard | Test would fail if the fix were reverted (delete the fix, confirm red) | Preferred |

Run `npm test` for the Vitest suite and `npm run typecheck` for TypeScript.

#### API / Server

| Evidence | Standard | Column |
| :--- | :--- | :--- |
| Handler test | Request/response test per route, including one invalid input | Required |
| Error mapping | Error responses match `docs/api-reference.md`; status codes documented | Required |
| Contract stability | Existing responses are not reshaped; additive changes only | Required |
| Logs | Structured logs for the new path, no secrets or token material | Preferred |
| Rate limit / auth | New endpoint declares its auth requirement in the API reference | Preferred |
| Rollback note | How to revert the change without data loss | Preferred |

The Express workspace under `server/` has its own lockfile and test runner; run
`cd server && npm test`.

#### Contracts / Chain logic

| Evidence | Standard | Column |
| :--- | :--- | :--- |
| Contract tests | `cargo test -p prompt-hash` passes, including the new invariant | Required |
| Storage layout | Any new storage key documented with its type and collision reasoning | Required |
| Cost accounting | Resource budget or gas behaviour considered and stated | Required |
| Upgradeability | Note on whether the change is safe for an existing deployed contract | Preferred |
| Revert path | How to undo the change on testnet, including data migration | Preferred |
| Testnet proof | Transaction hash or event log from a testnet run | Preferred |

Contracts live under `contracts/`; see `docs/architecture.md` for the storage
model.

#### Documentation / Tooling

| Evidence | Standard | Column |
| :--- | :--- | :--- |
| Link integrity | Every path referenced by the new doc exists in the repository | Required |
| Verifiability | A script or CI check enforces the promise the doc makes | Required |
| Audience clarity | The doc states who it is for and what they should do next | Required |
| No drift source | Anything that can go stale is generated or checked, not hand-edited | Preferred |
| Searchable | Terms match existing docs so contributors can find it by keyword | Preferred |

`node scripts/check-issue-templates.mjs` verifies this domain's template and
rubric references.

#### Security

| Evidence | Standard | Column |
| :--- | :--- | :--- |
| Threat statement | One sentence naming the attack or leak the change closes | Required |
| Negative test | Test that fails if the insecure path is restored | Required |
| Secret handling | No private key, deployer secret, or token is logged or echoed | Required |
| Input boundary | Untrusted input is validated before use, with a named validator | Preferred |
| Advisory path | Private reporting route pointed out, not public issue discussion | Preferred |
| Audit trail | What a reviewer can inspect to confirm the fix held | Preferred |

Security context lives in `docs/security-model.md` and `docs/security-audit.md`.

---

## Maintainer Review Checklist

Work top to bottom. Any "No" on a gating item blocks merge.

### 1. Issue hygiene

- [ ] The issue used `.github/ISSUE_TEMPLATE/hard-issue.yml` and named a rubric domain.
- [ ] Problem, scope, acceptance criteria, and test expectations are all filled in.
- [ ] Acceptance criteria are observable outcomes, not implementation steps.
- [ ] Complexity estimate is present and matches the scope.

### 2. Design note

- [ ] Contributor posted a short design note before implementing, or the change is
      small enough that one was not needed.
- [ ] The implemented approach matches the design note; deviations are called out in the PR.

### 3. Tests

- [ ] New or updated tests exist for the changed behaviour.
- [ ] Tests run locally by the contributor and the log is in the PR.
- [ ] At least one test covers the negative case, not just the happy path.

### 4. Rubric evidence

- [ ] Required rubric columns for the issue's domain are satisfied.
- [ ] Screenshots or logs are attached where the rubric asks for them.

### 5. Code review

- [ ] Diff is focused; no unrelated refactors mixed in.
- [ ] No secrets, deployer keys, or tokens in code, logs, or fixtures.
- [ ] Types check; no `any` introduced to silence the compiler.
- [ ] Docs updated for any new behaviour, env var, or API surface.

### 6. Reward review

- [ ] The reward review requirement stated in the issue is verifiable from the PR.
- [ ] Reward amount and token are confirmed before merge, if the campaign requires them.
- [ ] Merge is only approved after the contributor's PR checklist is complete.

---

## Running the checks

```bash
npm test                                # frontend Vitest suite
npm run typecheck                       # TypeScript
node scripts/check-issue-templates.mjs  # this rubric and the issue templates
cd server && npm test                   # serverless API tests
```
