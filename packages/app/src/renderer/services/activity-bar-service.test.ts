import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ACTIVITY_BAR_VIEWS,
  DEFAULT_SIDE_BAR_WIDTH,
  createActivityBarService,
} from "./activity-bar-service";

describe("createActivityBarService", () => {
  test("registers the six default activity views with side bar routes", () => {
    const store = createActivityBarService();
    const service = store.getState();

    expect(service.views).toHaveLength(6);
    expect(service.views.map((view) => view.id)).toEqual([
      "explorer",
      "search",
      "source-control",
      "tool",
      "session",
      "preview",
    ]);
    expect(service.views.map((view) => view.sideBarContentId)).toEqual(
      DEFAULT_ACTIVITY_BAR_VIEWS.map((view) => view.id),
    );
    expect(service.getActiveSideBarRoute()).toEqual({
      title: "Explorer",
      contentId: "explorer",
    });
  });

  test("switches the active view and exposes side bar metadata", () => {
    const store = createActivityBarService();

    store.getState().setActiveView("source-control");

    expect(store.getState().activeViewId).toBe("source-control");
    expect(store.getState().getActiveView()).toMatchObject({
      id: "source-control",
      label: "Source Control",
      sideBarTitle: "Source Control",
      sideBarContentId: "source-control",
    });
    expect(store.getState().getActiveSideBarRoute()).toEqual({
      title: "Source Control",
      contentId: "source-control",
    });
  });

  test("registers custom views and preserves routing when updating by id", () => {
    const store = createActivityBarService();

    store.getState().registerView({
      id: "custom-tool",
      label: "Custom Tool",
      sideBarTitle: "Custom",
      sideBarContentId: "tool-feed",
    });
    store.getState().registerView({
      id: "custom-tool",
      label: "Renamed Tool",
      sideBarTitle: "Renamed",
    });
    store.getState().setActiveView("custom-tool");

    expect(store.getState().views.filter((view) => view.id === "custom-tool")).toHaveLength(1);
    expect(store.getState().getActiveView()).toEqual({
      id: "custom-tool",
      label: "Renamed Tool",
      sideBarTitle: "Renamed",
      sideBarContentId: "tool-feed",
    });
  });

  test("toggles and explicitly sets side bar collapsed state", () => {
    const store = createActivityBarService();

    expect(store.getState().sideBarCollapsed).toBe(false);

    store.getState().toggleSideBar();
    expect(store.getState().sideBarCollapsed).toBe(true);

    store.getState().toggleSideBar();
    expect(store.getState().sideBarCollapsed).toBe(false);

    store.getState().setSideBarCollapsed(true);
    expect(store.getState().sideBarCollapsed).toBe(true);
  });

  test("persists width and collapse state through a serializable snapshot", () => {
    const store = createActivityBarService();

    store.getState().setActiveView("preview");
    store.getState().setSideBarWidth(360);
    store.getState().setSideBarCollapsed(true);

    const snapshot = store.getState().getSnapshot();
    const restored = createActivityBarService(snapshot);

    expect(snapshot).toEqual(store.getState().getState());
    expect(restored.getState().getSnapshot()).toMatchObject({
      activeViewId: "preview",
      sideBarCollapsed: true,
      sideBarWidth: 360,
    });
    expect(restored.getState().getActiveSideBarRoute()).toEqual({
      title: "Preview",
      contentId: "preview",
    });
    expect(createActivityBarService().getState().sideBarWidth).toBe(DEFAULT_SIDE_BAR_WIDTH);
  });

  test("ignores unknown active view ids", () => {
    const store = createActivityBarService();
    const before = store.getState().getSnapshot();

    store.getState().setActiveView("missing-view");

    expect(store.getState().getSnapshot()).toEqual(before);
    expect(store.getState().getActiveView()?.id).toBe("explorer");
  });
});
