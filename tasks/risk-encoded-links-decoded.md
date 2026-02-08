# Task: Document Encoded Link Limitation

## Risk
Encoded links are easily decoded.

## Goal
Make the limitation explicit in user-facing documentation and in-app copy so users do not assume security.

## Scope
- Add a clear statement in user-facing docs that encoded links are not secure.
- Add a short disclaimer near the share link (or a help tooltip) explaining that the encoding is for convenience, not secrecy.

## Acceptance Criteria
- Documentation explicitly states that encoded links can be decoded and should not be treated as secure.
- The share UI includes a brief disclaimer or help text.

## Dependencies
- Decide the canonical user-facing doc location (README or in-app help).
