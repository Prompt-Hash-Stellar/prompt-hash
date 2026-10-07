# Contributing to Prompt Hash

Thank you for your interest in contributing to Prompt Hash! This document outlines the processes and expectations for contributors.

## Getting Started

1. Fork the repository and create a branch from `main`
2. Read the relevant documentation in `docs/`
3. Check existing issues for anything similar to your proposed work

## Issue Templates

We use structured issue templates to ensure consistency:

- **[Hard GrantFox Issue](.github/ISSUE_TEMPLATE/hard-grantfox-issue.md)** — For complex, high-effort tasks requiring thorough testing and security review (200 points).

## Contributing a Hard Issue (GrantFox)

When working on a hard GrantFox issue:

1. **Design Phase**: Post a short design note in the issue discussion before starting implementation.
2. **Implementation**: Write focused tests covering the affected workflow.
3. **Verification**: Ensure all acceptance criteria are met, including:
   - Unit and integration tests
   - Screenshots for UI changes
   - Security review documentation
4. **Documentation**: Update relevant docs (`README.md`, `docs/`) for any behavioral changes.
5. **PR Submission**: Reference the issue number in your PR title and description.

## Verification Rubric

| Domain | Criteria |
|--------|----------|
| Core Logic | Correct, complete, no regressions |
| Security | No new vulnerabilities, inputs validated |
| Testing | Adequate unit + integration coverage |
| Docs | README or CONTRIBUTING updated as needed |

## Reward Review

All hard issues require explicit reward review before closure:

- [ ] Difficulty aligns with estimated points
- [ ] Acceptance criteria fully met
- [ ] Tests pass with adequate coverage
- [ ] Security review completed
- [ ] Screenshots and documentation provided

## Code of Conduct

Please be respectful and constructive in all interactions.

## Reporting Security Issues

Do not file public issues for security vulnerabilities. Instead, contact the maintainers directly.
