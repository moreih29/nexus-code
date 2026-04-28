# Empirical — Plan 33 VSCode-superhost retrospective

## Scope

Plan #33 moved the renderer toward a VSCode-superior workbench surface while preserving the project identity: multi-workspace operation, three-harness observation, and Korean IME/rendering quality.

## What worked

- Splitting `design.md` into philosophy plus flat design spec files reduced conflict risk. The reviewer caught semantic duplicate ownership issues early; explicit responsibility lines and cross-links made correction cheap.
- `flexlayout-react@0.9.0` passed the adoption gate in an isolated spike and a system smoke fixture. The fallback path was not needed.
- The service-boundary-first approach made later UI work less ambiguous. The 8 renderer services now have method-level tests and integration tests for the key cooperation paths.
- The regression policy paid off immediately: new `dock-layout-runtime`, `activity-bar-runtime`, and `workspace-layout-persist-runtime` fixtures converted layout decisions into executable gates.
- The right Shared Panel removal became safer once Activity Bar and Side Bar were modelled as service state and separate parts.

## What was difficult

- Full visual FlexLayout replacement remains larger than a single safe step. The current editor groups part exposes six-slot/flexlayout-ready hooks, while some legacy SplitEditorPane rendering remains under the new service boundary.
- `App.tsx` was reduced to a thin entrypoint, but the large implementation moved to `app/AppShell.tsx`. The entrypoint goal is met; deeper behavioral decomposition is still future debt.
- A Zustand selector returning a fresh object triggered `getSnapshot should be cached` and `Maximum update depth exceeded` in the App-level system smoke. Memoizing the route in AppShell fixed the runtime loop.
- Existing system fixtures encoded old right-panel assumptions. Updating them required replacing old Source Control panel expectations with Activity Bar / Side Bar navigation assertions rather than weakening the checks.

## Flexlayout result

- First-choice adoption succeeded: `flexlayout-react@0.9.0`, not `dockview-react` or a custom grid.
- Verified criteria: six split panes, dock location probes, symmetric splitter model, floating support, oklch CSS bridge, and StrictMode/system smoke stability.
- Remaining risk: full pointer-drag UX and visual dock overlay behavior are still partly represented by model/runtime probes, not full durable/automated pointer-drag E2E coverage.

## Service split ROI

- Positive: services made Activity Bar, Bottom Panel, Workspace layout persistence, terminal metadata, and editor-group model tests possible without full App boot.
- Cost: compatibility wrappers were needed during migration, and `editor-model-service` still carries legacy editor model behavior formerly named `editor-store`.
- Rule learned: move behavior by module boundary first, then do semantic refactors after smoke fixtures are green.

## Test pyramid effect

- Unit/service tests caught method-level regressions cheaply.
- Integration tests covered service coordination and subscription cleanup.
- System smokes caught the high-value failures: update-depth loops, layout persistence loss, Activity Bar route regressions, and stale file-tree fixture assumptions.

## Follow-up debt

- Break down `app/AppShell.tsx` into narrower wiring modules or service adapters.
- Replace remaining legacy SplitEditorPane visual rendering with full FlexLayout editor group rendering.
- Add fuller pointer-drag E2E coverage for docking/tear-off when the UI is stable enough.
- Decide whether workspace layout should persist after explicit workspace close; current service behavior removes it to preserve existing contract semantics.
