# Task: Guard Against Mobile Layout Regressions

## Risk
Mobile layout regressions can break core gameplay on phones.

## Goal
Keep mobile layout stable across common device sizes.

## Scope
- Define responsive constraints for board and keyboard sizing.
- Add manual device checks for iOS and Android.
- Add a lightweight visual regression check for mobile breakpoints (optional).

## Acceptance Criteria
- Manual checks pass on at least one iOS and one Android device.
- Board and keyboard remain fully usable at common mobile widths.
- Safe-area insets and 100dvh behavior are verified.

## Implementation Notes
- Added Playwright viewport checks for iPhone 13 and Pixel 7 in `tests/ui/mobile.spec.js`.

## Status
- Done (2026-02-08)
