# Task: Prevent Admin Key Misconfiguration Failures

## Risk
Admin key misconfiguration can block admin operations without clear feedback.

## Goal
Provide clear errors and documentation for admin key usage.

## Scope
- Ensure admin endpoints return 401/403 on missing/invalid keys.
- Add explicit error messages for unauthorized admin requests.
- Document required environment variables and expected headers.

## Acceptance Criteria
- Unauthorized admin requests receive 401/403 with readable errors.
- Admin configuration is documented in setup/usage docs.
- No admin UI is exposed.
