/**
 * Public re-exports from the logging facade.
 *
 * Process-specific entry points:
 *   - Main process  → import from `src/shared/log/main`
 *   - Renderer      → import from `src/shared/log/renderer`
 *
 * This index exports only the shared type surface so that modules needing
 * only the Logger interface do not inadvertently pull in a process-specific
 * implementation.
 */

export type { Logger, LogLevel, LogMeta, LogSource } from "./types";
