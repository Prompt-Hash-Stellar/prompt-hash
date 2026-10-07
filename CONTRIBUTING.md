# Contributing & Local Setup — Prompt-Hash-Stellar

Welcome! Thanks for wanting to contribute. This guide helps you get the repo running locally (frontend + Soroban contracts) quickly and safely.

Table of contents
- Prerequisites
- Quick checks
- Step-by-step setup
- Environment variables (.env.example)
- Run the app & contracts
- Project structure overview
- Testing
- How to contribute (PRs, style, tests)
- GrantFox Hard Issues (Verification Rubric)

---

## 1) Prerequisites (install these first)

- **Node.js** — LTS (recommended v18+)
- **A package manager** — npm, yarn, or pnpm
- **Rust toolchain (stable)** and cargo
- **Soroban CLI**
- **Git**

---

## 7) How to contribute (PR checklist)

When opening a PR:
- Create a feature branch off `main`: `git checkout -b feat/your-feature`
- Keep commits focused & atomic.
- Add or update tests for new logic.
- Run linters & formatters locally.
- Update docs (if new behavior or env vars).
- In PR description: explain what you changed, why, and how to test manually.
- Tag reviewers and add an issue reference if applicable.

---

## 10) GrantFox Hard Issues (Verification Rubric)

For high-complexity tasks, contributors must follow the `hard-issue.md` template. Maintainers will evaluate PRs based on:

1. **Functional Correctness**: Does the code solve the problem as defined in the issue?
2. **Security**: Are all inputs sanitized? Are there any potential vulnerabilities (e.g., reentrancy in contracts, XSS in frontend)?
3. **Test Coverage**: Are there sufficient tests for the new functionality?
4. **Documentation**: Is the code self-documenting and are relevant docs updated?

---

## 8) Security & best practices

- **Never** commit secrets or private keys.
- Use a hardware wallet / Freighter for real transactions.
- Prefer testnet for development and manual testing.

---

## 9) Need help?

- Open an issue with the `help wanted` label.
- Join the project discussions or ping maintainers in the issue/PR.

Thanks for contributing — your help makes Prompt-Hash-Stellar better!