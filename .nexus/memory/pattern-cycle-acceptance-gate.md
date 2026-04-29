# Cycle acceptance gate pattern

## Problem

Line-count acceptance gates are weak when they only measure size. A file can pass a numeric target while still accumulating inefficient wiring, or fail the target because legitimate responsibilities grew during the cycle.

Treat a size gate as a diagnostic prompt, not as the architecture decision itself. The useful question is: **which wiring area is growing without a real responsibility boundary?** Cycle-specific facts belong in `.nexus/history.json`; memory should keep only the reusable rule.

## Pattern

Use acceptance gates to identify inefficient wiring, then extract only where a boundary is real.

1. Classify the growth before cutting code:
   - props drilling across a stable UI boundary
   - scattered store selectors or duplicated derived state
   - cyclic binding setup that hides initialization order
   - service-boundary glue mixed into shell/layout code
   - layout behavior without a smoke fixture
2. Extract the smallest responsibility unit:
   - hook for state, subscription, consent, or binding orchestration
   - container component for props mapping into a child surface
   - service method only when domain behavior, not UI wiring, owns the rule
3. Keep the gate attached to behavior:
   - a size reduction alone is not enough
   - the extracted unit needs its own test or fixture when it owns behavior
   - the shell should read as composition after extraction
4. Cross-check selector work against [Zustand selector stability](./pattern-zustand-selector-stability.md). Do not replace scattered selectors with one unstable object selector.

## Trade-offs

- Numeric gates are simple to review, but they are easy to game by moving code without improving ownership.
- Responsibility extraction costs more during the cycle, but it prevents the same shell/wiring debt from reappearing in the next cycle.
- A strict gate can force premature abstraction. A loose gate can normalize drift. Prefer a bounded gate plus an explicit explanation of what growth was classified and why it was accepted.
- If the gate is about tests, layout, or fixture placement, use the decision axes in [test layout decision](./pattern-test-layout-decision.md) before creating permanent directories or moving tests.

## Fixture obligation

Layout-critical and service-boundary changes need smoke or system fixtures. Otherwise the acceptance gate only proves that code was rearranged.

Add or update fixtures when the change affects:

- pane, split, dock, tab, or workspace layout behavior
- persistence or round-trip restore behavior
- IPC, consent, or other cross-process service boundaries
- drag/drop, keyboard binding, or command routing
- selector stability under React render pressure

The fixture should exercise the user-visible invariant, not just the helper function. For checklist-style release gates, align evidence rules with [phase gate checklist](./pattern-phase-gate-checklist.md).

## Examples

- An app shell grew because wiring accumulated. The fix was not to chase a lower line count first; it was to identify state, consent, binding, and container boundaries, then extract each only where it had a coherent responsibility.
- A selector cleanup reduced local clutter but risked returning fresh objects on every render. The correct gate included selector stability, not just fewer calls in the shell.
- A layout policy changed near the boundary between model and UI. The honest acceptance gate required a runtime fixture that proved the visible layout invariant after the operation and after restore.
- A test organization change looked like cleanup, but the durable decision was about build hygiene, import depth, ecosystem convention, and migration cost. The gate belonged to those axes, not to the number of files moved.

## Counter-pattern

**Bounded pass by acceptance weakening**: near the end of a cycle, the team relaxes the gate because the remaining work is inconvenient. This can be valid only when explicitly recorded as a scoped exception with follow-up ownership. As a default habit, it reduces immediate work while pushing the same debt forward.

Warning signs:

- the gate changes from behavior to wording only
- the same file or subsystem repeatedly appears as “acceptable for now”
- fixtures are deferred even though the change crosses a layout or service boundary
- code is moved to satisfy a number, but no new responsibility boundary can be named

When this appears, stop treating the gate as pass/fail bookkeeping. Reclassify the growth, choose the smallest real boundary, and keep cycle-specific detail in `.nexus/history.json` rather than adding an empirical memory note.
