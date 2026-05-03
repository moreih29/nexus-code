# services/

Renderer-side service layer — domain orchestration that composes stores and IPC channels.

## Layering

| Layer | Folder | Responsibility |
|---|---|---|
| Engine | `src/renderer/split-engine/` | Domain-agnostic primitives (split tree). |
| Store | `src/renderer/store/` | Persisted state (zustand). Pure record/structure mutations. |
| **Service** | **`src/renderer/services/`** | **Cross-store + IPC orchestration. Owns identity, lifecycle, and routing decisions.** |
| UI | `src/renderer/components/` | Presentation. Calls services for actions. |

## Convention

- **Single-file service**: small, single-concern services live as one file (`renderer/services/<name>-service.ts`).
- **Folder service**: services that are predicted to grow past ~300 lines or split into independent submodules use a folder with `index.ts` barrel + role-named modules (`renderer/services/<name>/{index,...}.ts`).
- **Mirror VSCode separation**: cross-process services use main-side counterparts in `src/main/ipc/channels/` plus the shared contract in `src/shared/ipc-contract.ts`.

## Current services

- `editor/` — folder service. Owns openOrReveal, Monaco model lifecycle, LSP bridge, file loader.
