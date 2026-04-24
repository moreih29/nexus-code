export type SidecarShutdownHook = () => Promise<void> | void;

let sidecarShutdownHook: SidecarShutdownHook | undefined;

export function registerSidecarShutdownHook(hook: SidecarShutdownHook): void {
  sidecarShutdownHook = hook;
}

export function clearSidecarShutdownHook(): void {
  sidecarShutdownHook = undefined;
}

export async function runSidecarShutdownHook(): Promise<void> {
  if (!sidecarShutdownHook) {
    return;
  }

  await sidecarShutdownHook();
}
