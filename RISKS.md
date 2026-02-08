# MyWordle Local — Risks

| Risk | Impact | Likelihood | Mitigation |
| --- | --- | --- | --- |
| Encoded links are easily decoded | Medium | High | Document as limitation; keep “security” out of scope. |
| Dictionary gaps for non‑English | Medium | Medium | Expand dictionaries or allow no‑dictionary mode. |
| Accessibility regressions | High | Medium | Keep WCAG checks in CI; add a11y smoke checks. |
| Strict mode logic edge cases | Medium | Medium | Add more tests for repeated letters. |
| Mobile layout regressions | High | Low | Device testing on iOS/Android, use responsive constraints. |
| Daily word timezone/date drift | Medium | Medium | Define timezone behavior; test date boundaries. |
| Missing or empty dictionary files | Medium | Medium | Validate at startup; omit from language list. |
| Corrupted `data/word.json` | Medium | Low | Validate on boot; regenerate defaults if invalid. |
| Admin key misconfiguration | Medium | Medium | Add clear 401/403 errors and setup docs. |
| Malformed share links cause crashes | Medium | Medium | Validate inputs and return friendly errors. |
