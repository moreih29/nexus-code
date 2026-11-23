export interface RunReaderWindow {
  readonly webContents: {
    readonly id: number;
    on(
      event: "did-start-navigation",
      listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void,
    ): unknown;
  };
  on(event: "closed", listener: () => void): unknown;
}

export function endRunReadersWithWindow(
  win: RunReaderWindow,
  closeReadersOf: (opener: number) => void,
): void {
  const opener = win.webContents.id;
  win.on("closed", () => closeReadersOf(opener));
  win.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) closeReadersOf(opener);
  });
}
