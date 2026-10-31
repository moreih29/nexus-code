/**
 * Renderer switch for a window created transparent on Linux. Its frame then
 * draws no window controls, so the titlebar draws its own; the preload
 * exposes the switch as `host.transparentWindow`.
 */
export const TRANSPARENT_WINDOW_ARG = "--nexus-transparent-window";

/**
 * Renderer switch for a Windows window without a system backdrop, before
 * Windows 11 22H2: nothing shows through it, so the window opacity has no
 * effect there; the preload exposes the switch as `host.opaqueWindow`.
 */
export const OPAQUE_WINDOW_ARG = "--nexus-opaque-window";
