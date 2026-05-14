# Dead-terminal banner contrast + copy review

Measured on 2026-05-14 for task T9.

## Final after T9 revision

Revision applied on 2026-05-14 after the initial `REVISION_REQUIRED` finding.

Code changes:

- Added `app-status-banner-text`, backed by `--color-status-banner-fg`, in `src/renderer/styles/globals.css`.
  - Dark/current scopes (`:root`, `[data-theme="dark"]`, `.dark`): Warm Parchment `oklch(0.982 0.0041 91.45)` / `#faf9f6`.
  - Light/future scopes (`[data-theme="light"]`, `.light`): Earth Gray `oklch(0.3286 0.0017 106.49)` / `#353534`.
- Applied that utility to `DeadTerminalBanner`, `WorkspaceTerminalStatusBanner`, and existing `ReadOnlyBanner`, including their action buttons.
- Changed dead-terminal copy to cause-neutral strings because the call sites still do not carry a typed exit cause:
  - Per-tab: `Terminal ended.`
  - Reopen failure: `Reopen failed.`
  - Aggregate: `{N} terminal(s) ended.`

Revised contrast results, using the same composited backgrounds and WCAG method below:

| Scenario | App background | Composited banner background | Revised text color | Text ratio vs banner | AA 4.5:1 |
| --- | --- | --- | --- | ---: | --- |
| Dark/current | `#1a1917` | `#232220` | `#faf9f6` | `15.10:1` | PASS |
| Light/future scenario | `#faf9f6` | `#faf9f6` | `#353534` | `11.66:1` | PASS |

Final task verdict after revision: **PASS** for the checked banner contrast and copy criteria. The original finding remains below as the evidence trail for why the shared banner utility was added.

## Scope checked

Banner class tuple found in:

- `src/renderer/components/workspace/content/terminal-view.tsx` — `DeadTerminalBanner`
- `src/renderer/components/workspace/workspace-terminal-status-banner.tsx` — `WorkspaceTerminalStatusBanner`
- `src/renderer/components/workspace/content/read-only-banner.tsx` — existing `ReadOnlyBanner` using the same visual token tuple

Shared banner visual tokens:

```txt
bg-frosted-veil border-b border-mist-border text-app-ui-xs text-muted-foreground
```

Resolved token values from `src/shared/design-tokens.ts` and `src/renderer/styles/theme.generated.css`:

- Text: `--color-muted-foreground: oklch(0.6173 0.0019 67.79)` → sRGB `#868584`
- Default/hover action text: `--color-foreground: oklch(0.982 0.0041 91.45)` → sRGB `#faf9f6`
- Banner fill: `--color-frosted-veil: rgba(255, 255, 255, 0.04)`
- Border: `--color-mist-border: rgba(226, 226, 226, 0.35)`
- Dark app background: `--background: #1a1917`
- Light measurement background: `#faf9f6` (Warm Parchment light canvas used by the existing light contrast note in `.nexus/memory/external-git-lane-contrast.md`). Current app semantic tokens do not define a full light-mode override for this banner tuple, so this is a required future-light scenario rather than an active runtime theme.

## Method

- Conversion: `culori.converter("rgb")` for OKLCH → sRGB, clamped to `[0, 1]`.
- Translucent banner fill: CSS alpha-composited in sRGB over the app background before contrast calculation.
  - Dark: `rgba(255,255,255,0.04)` over `#1a1917` → `#232220`.
  - Light: `rgba(255,255,255,0.04)` over `#faf9f6` → `#faf9f6` after rounding.
- Border: composited over the already-composited banner fill because the element background paints under the border.
- Luminance: WCAG sRGB relative luminance.
- Text acceptance threshold: WCAG AA normal text `>= 4.5:1`. Banner text is `12px`, so it is normal text, not large text.

## Contrast results

| Scenario | App background | Composited banner background | Text token | Text ratio vs banner | AA 4.5:1 |
| --- | --- | --- | --- | ---: | --- |
| Dark/current | `#1a1917` | `#232220` | `#868584` | `4.31:1` | FAIL |
| Light/future scenario | `#faf9f6` | `#faf9f6` | `#868584` | `3.50:1` | FAIL |

Reference ratios:

| Scenario | Text ratio vs raw app bg | Hover/action `text-foreground` vs banner | Border final color | Border ratio vs banner |
| --- | ---: | ---: | --- | ---: |
| Dark/current | `4.77:1` | `15.06:1` | `#666564` | `2.74:1` |
| Light/future scenario | `3.50:1` | `1.00:1` | `#f2f1ef` | `1.07:1` |

## Contrast finding

**FAIL.** The normal text contrast failure is not isolated to the new terminal banner. It is the shared `bg-frosted-veil` + `text-muted-foreground` banner token combination.

Affected scope:

1. `DeadTerminalBanner` in `terminal-view.tsx`.
2. `WorkspaceTerminalStatusBanner` in `workspace-terminal-status-banner.tsx`.
3. Existing `ReadOnlyBanner` in `read-only-banner.tsx`.

Dark-mode nuance: `text-muted-foreground` passes against the raw app background (`4.77:1`) but fails after the 4% white frosted veil is composited (`4.31:1`). Fixing only the terminal banner would leave the same AA failure in `ReadOnlyBanner`.

## Copy review

Checked strings:

- `terminalEndedMessage()`:
  - `Terminal ended — agent stopped`
  - `Terminal ended — connection to {host} lost`
  - `Reopen failed — agent unavailable.`
- `workspaceTerminalStatusMessage()`:
  - `Disconnected from {host|agent} — N terminal(s) ended.`

Evidence from the implementation:

- `PtyClientOptions.onExit` / `TerminalControllerOptions.onExit` carry only `{ code: number | null }`.
- `terminalEndedMessage()` receives only `workspace` and `reopenState`, not a classified exit cause.
- `recordTerminalDeathForAggregate()` groups any terminal deaths within a 100ms workspace window; it does not record whether the source was a channel disconnect, normal shell exit, user-initiated exit, or agent failure.

Copy verdict: **REVISION_REQUIRED**. The copy avoids claims like “Build cancelled” or “process killed”, but it still asserts causal state that is not available at the copy call sites.

Concrete correction recommendations:

1. Per-tab banner: use cause-neutral local-view facts unless a typed exit reason is added. Example: `Terminal ended.` and, for failure, `Reopen failed.` rather than `agent stopped`, `connection to {host} lost`, or `agent unavailable` for every caught reopen error.
2. Workspace aggregate banner: use a neutral aggregate when the only evidence is the 100ms death window, e.g. `{N} terminals ended.`, and reserve `Disconnected from {host}` / `Workspace offline` for a code path that carries an explicit channel/offline cause.

## Commands run

```sh
cat /Users/kih/workspaces/areas/nexus-code/.agents/skills/nx-run/SKILL.md
find .. -name AGENTS.md -print
pwd; git branch --show-current; git status --short
cat .nexus/context/{mission.md,conventions.md,design.md}
# nx_task_list(include_completed=true) and nx_plan_status via Nexus MCP
sed -n '1,260p' src/renderer/components/workspace/content/terminal-view.tsx
sed -n '1,260p' src/renderer/components/workspace/workspace-terminal-status-banner.tsx
sed -n '1,180p' src/shared/design-tokens.ts
sed -n '1,220p' src/renderer/styles/theme.generated.css
sed -n '1,240p' src/renderer/styles/globals.css
rg -n "frosted|mist|muted-foreground|ReadOnlyBanner|Terminal ended|Disconnected from|Reopen failed|agent stopped|connection to|Build cancelled|process killed|cancelled|killed" src/renderer src/shared tests/unit/renderer
sed -n '1,260p' src/renderer/state/stores/terminal-deaths.ts
sed -n '1,260p' src/renderer/services/terminal/terminal-controller.ts
sed -n '1,260p' src/renderer/services/terminal/pty-client.ts
bun .nexus/tmp-banner-contrast.ts
rm .nexus/tmp-banner-contrast.ts
```

## Initial reviewer verdict before revision

**REVISION_REQUIRED** — contrast missed WCAG AA for normal text in current dark mode and future-light measurement, and banner copy needed neutral wording or a typed exit-cause source. The final revised verdict is recorded at the top of this note.
