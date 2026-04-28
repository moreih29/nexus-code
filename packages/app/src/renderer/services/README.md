# Renderer services

Renderer parts and components should import service interfaces and factories from `src/renderer/services`.
Do not import raw Zustand stores directly from `src/renderer/stores` in new workbench code.

```ts
import { createWorkspaceService, type IWorkspaceService } from "@/services";
```

The service files in this directory are the Plan #33 service-boundary skeletons. They are intentionally minimal Zustand-backed implementations so the workbench parts can wire against stable interfaces before the existing store behavior is migrated.
