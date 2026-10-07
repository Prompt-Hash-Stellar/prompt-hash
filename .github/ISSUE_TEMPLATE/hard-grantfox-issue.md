---
name: GrantFox Hard Issue
about: Standard template for hard GrantFox contributor tasks
title: '[Hard] '
labels: 'hard-issue, grantfox'
assignees: ''
---

## Problem

<!-- Clear, concise description of the problem being solved -->

## Scope

<!-- Bullet-point list of deliverables and out-of-scope items -->

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Test Expectations

| Area | Requirement |
|------|-------------|
| Unit tests | Cover all public functions with edge cases |
| Integration tests | Validate end-to-end workflow |
| Screenshot | Include before/after UI screenshots if applicable |
| Security review | Document threats and mitigations |

## Reward Review Requirements

- [ ] Difficulty estimated at **High** (200 points) or per rubric
- [ ] All acceptance criteria met and verifiable
- [ ] Tests pass and coverage meets minimum threshold
- [ ] Security review completed by maintainer
- [ ] Screenshots/documentation provided where required

## Verification Rubric

| Domain | Rubric |
|--------|--------|
| Core logic | Correctness, completeness, no regressions |
| Security | No new vulnerabilities, input validated |
| Testing | Adequate unit + integration coverage |
| Docs | README or CONTRIBUTING updated if needed |

## Maintainer Review Checklist

- [ ] Design note reviewed and approved in issue discussion
- [ ] Code follows project conventions and style guide
- [ ] All acceptance criteria verified
- [ ] Tests added and passing
- [ ] No new dependencies without approval
- [ ] Security review signed off
- [ ] Documentation updated

## Contributor Guidance

1. Start with a **short design note** in the issue discussion
2. Implement with **focused tests** for the affected workflow
3. Add **documentation** for any changed behavior
4. Include **screenshots** for UI-related changes
5. Submit PR referencing this issue number
