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
