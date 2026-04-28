import { describe, expect, test } from "bun:test";

import {
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  createBottomPanelService,
  type BottomPanelPosition,
} from "./bottom-panel-service";

describe("IBottomPanelService", () => {
  test("starts with Terminal, Output, and Problems views", () => {
    const store = createBottomPanelService();
    const snapshot = store.getState().getSnapshot();

    expect(snapshot.views.map((view) => view.id)).toEqual(["terminal", "output", "problems"]);
    expect(snapshot.activeViewId).toBe("terminal");
    expect(snapshot.position).toBe("bottom");
    expect(snapshot.expanded).toBe(true);
    expect(snapshot.height).toBe(DEFAULT_BOTTOM_PANEL_HEIGHT);
  });

  test("registers, activates, and unregisters views without owning terminal tabs", () => {
    const store = createBottomPanelService();

    store.getState().registerView({ id: "ports", label: "Ports" });
    store.getState().setActiveView("ports");

    expect(store.getState().getActiveView()).toEqual({ id: "ports", label: "Ports" });
    expect(store.getState().expanded).toBe(true);

    store.getState().unregisterView("ports");

    expect(store.getState().views.map((view) => view.id)).toEqual(["terminal", "output", "problems"]);
    expect(store.getState().activeViewId).toBe("terminal");
  });

  test("supports all four panel positions", () => {
    const store = createBottomPanelService();
    const positions: BottomPanelPosition[] = ["left", "right", "top", "bottom"];

    for (const position of positions) {
      store.getState().setPosition(position);
      expect(store.getState().position).toBe(position);
    }
  });

  test("toggles panel expansion", () => {
    const store = createBottomPanelService();

    store.getState().togglePanel();
    expect(store.getState().expanded).toBe(false);

    store.getState().togglePanel();
    expect(store.getState().expanded).toBe(true);
  });

  test("persists height by workspace layout key", () => {
    const store = createBottomPanelService();

    store.getState().setHeightPersistenceKey("nx.layout.ws_alpha");
    store.getState().setHeight(420);
    store.getState().setHeightPersistenceKey("nx.layout.ws_beta");

    expect(store.getState().height).toBe(DEFAULT_BOTTOM_PANEL_HEIGHT);

    store.getState().setHeight(280);
    store.getState().setHeightPersistenceKey("nx.layout.ws_alpha");

    expect(store.getState().height).toBe(420);
    expect(store.getState().getSnapshot().heightByPersistenceKey).toEqual({
      "nx.layout.ws_alpha": 420,
      "nx.layout.ws_beta": 280,
    });
  });

  test("cleans up state subscriptions", () => {
    const store = createBottomPanelService();
    const snapshots: BottomPanelPosition[] = [];

    const unsubscribe = store.getState().onStateChanged((snapshot) => {
      snapshots.push(snapshot.position);
    });

    store.getState().setPosition("left");
    unsubscribe();
    store.getState().setPosition("right");

    expect(snapshots).toEqual(["left"]);
  });
});
