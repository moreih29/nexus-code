# App integration tests

Run all app integration tests with:

```bash
bun run test:integration
```

The integration suite is assertion-only and does not write evidence or artifact files.

- `ime-release-gate.test.ts`: deterministic Korean IME and rendering release-gate seams.
- `e2-terminal-runtime.test.ts`: deterministic terminal runtime harness for switching, lifecycle, leak-model, and scrollback checks.
