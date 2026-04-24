# IME Checklist Table — Task 11 Run

Source: `ime/ime-latest-evidence.json` + harness capability constraints.

| IME Item | Automated seam status | Native manual status | Overall |
| --- | --- | --- | --- |
| #1 Composition cursor alignment | PASS | NOT RUN | PARTIAL |
| #2 Enter during composition guard | PASS | NOT RUN | PARTIAL |
| #3 Hangul width (`ㅎ`,`가`) | PASS | NOT RUN | PARTIAL |
| #4 NFC path normalization | PASS | PASS (service-level deterministic test) | PASS |
| #5 No character drop during composition | PASS | NOT RUN | PARTIAL |
| #6 Input lag <16ms | PASS (deterministic harness) | NOT RUN | PARTIAL |
| #7 Font fallback includes D2Coding + Noto Sans KR | PASS (stack assertion) | NOT RUN | PARTIAL |

## Notes

- Existing automated tests validate deterministic seams and invariants.
- Native macOS IME behavior and screenshot/video evidence remain manual-required and were not performed in this harness.
