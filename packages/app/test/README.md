# App test suites

Unit tests stay co-located with implementation files under `src/**`.

Top-level app tests live under these suite directories:

- `integration/`: cross-module app integration checks. Run with `bun run test:integration`.
- `system/`: deterministic system/E2E-style release gates. Run with `bun run test:system`.
  - `ime-release-gate.test.ts`: Korean IME and rendering release-gate seams.
  - `terminal-runtime.test.ts`: terminal runtime harness for switching, lifecycle, leak-model, and scrollback checks.
- `packaging/`: packaging guard tests. Run with `bun run test:packaging`.
  - `check-dist-require.test.ts`: built artifact CommonJS `require(...)` guard coverage.
  - `font-bundle-config.test.ts`: bundled font and license packaging coverage.

Run all app test suites with:

```bash
bun run test
```
