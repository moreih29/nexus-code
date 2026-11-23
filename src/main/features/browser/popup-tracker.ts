import type { BrowserWindow } from "electron";

export class PopupTracker {
  private readonly popupsByWorkspace = new Map<string, Set<BrowserWindow>>();

  track(workspaceId: string, popup: BrowserWindow): void {
    let popups = this.popupsByWorkspace.get(workspaceId);
    if (!popups) {
      popups = new Set();
      this.popupsByWorkspace.set(workspaceId, popups);
    }
    popups.add(popup);
    popup.once("closed", () => {
      const current = this.popupsByWorkspace.get(workspaceId);
      if (!current) return;
      current.delete(popup);
      if (current.size === 0) this.popupsByWorkspace.delete(workspaceId);
    });
  }

  closeWorkspace(workspaceId: string): void {
    const popups = this.popupsByWorkspace.get(workspaceId);
    if (!popups) return;
    this.popupsByWorkspace.delete(workspaceId);
    for (const popup of popups) {
      if (!popup.isDestroyed()) popup.destroy();
    }
  }

  closeAll(): void {
    for (const workspaceId of [...this.popupsByWorkspace.keys()]) {
      this.closeWorkspace(workspaceId);
    }
  }
}
