# Contributor Guide

## Overview

This guide helps new and returning contributors navigate the Prompt Hash project.

## Project Structure

- `.github/ISSUE_TEMPLATE/` — Issue templates for standardized workflows
- `docs/` — Project documentation
- `CONTRIBUTING.md` — Contribution guidelines

## Issue Templates

| Template | Use Case |
|----------|----------|
| `hard-grantfox-issue.md` | Complex tasks (200 pts) with full testing, security review, and documentation requirements |

## Filing an Issue

1. Choose the appropriate template
2. Fill in all required sections
3. Tag with relevant labels

## Working on a Hard GrantFox Issue

1. **Design note**: Discuss your approach in the issue before coding
2. **Implement**: Write clean, well-tested code
3. **Test**: Add unit and integration tests; include screenshots for UI changes
4. **Security review**: Document any security considerations
5. **Document**: Update docs for changed behavior
6. **Submit PR**: Reference the issue number

## Verification Rubric

| Domain | What to Verify |
|--------|---------------|
| Core Logic | Functions behave correctly with edge cases; no regressions |
| Security | Inputs validated; no new vulnerabilities introduced |
| Testing | Unit + integration tests pass; coverage adequate |
| Docs | README / relevant pages updated |

## Maintainer Review Checklist

Maintainers use this checklist when reviewing hard issue PRs:

- [ ] Design note reviewed and approved
- [ ] Code follows project conventions
- [ ] All acceptance criteria verified
- [ ] Tests added and passing
- [ ] No unapproved new dependencies
- [ ] Security review signed off
- [ ] Documentation updated

## Need Help?

Open an issue or reach out to the maintainers.
