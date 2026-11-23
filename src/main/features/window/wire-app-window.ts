export interface AppWindowEvents {
  readonly webContents: {
    readonly id: number;
    on(
      event: "did-start-navigation",
      listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void,
    ): unknown;
  };
  on(event: "closed" | "focus" | "blur", listener: () => void): unknown;
}

export interface AppWindowHooks {
  closeRunReadersOf(opener: number): void;
  pauseAutofetch(paused: boolean): void;
  closeBrowserTabsOf(owner: number): void;
}

export function wireAppWindow(win: AppWindowEvents, hooks: AppWindowHooks): void {
  const contentsId = win.webContents.id;
  win.on("closed", () => {
    hooks.closeRunReadersOf(contentsId);
    hooks.closeBrowserTabsOf(contentsId);
  });
  win.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) hooks.closeRunReadersOf(contentsId);
  });
  win.on("blur", () => hooks.pauseAutofetch(true));
  win.on("focus", () => hooks.pauseAutofetch(false));
}
