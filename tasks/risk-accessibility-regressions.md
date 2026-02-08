# Task: Prevent Accessibility Regressions

## Risk
Accessibility regressions could violate WCAG 2.2 AA expectations.

## Goal
Add automated and manual checks that guard the core accessibility requirements.

## Scope
- Add automated a11y smoke checks for key screens (create and play).
- Add CI gating for a11y checks.
- Document required manual checks for screen reader and keyboard-only flows.

## Acceptance Criteria
- CI runs an a11y smoke check and fails on violations.
- Manual checklist includes screen reader and keyboard-only verification steps.
- High-contrast mode and non-color indicators are verified during QA.

## Implementation Notes
- Added axe-core Playwright checks in `tests/ui/a11y.spec.js` for create + play screens.
- `npm run test:ui` now enforces a11y smoke checks.

## Status
- Done (2026-02-08)
