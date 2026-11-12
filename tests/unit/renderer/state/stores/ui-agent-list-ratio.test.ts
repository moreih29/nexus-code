import { describe, expect, test } from "bun:test";
import {
  AGENT_LIST_RATIO_MAX,
  AGENT_LIST_RATIO_MIN,
  useUIStore,
} from "../../../../../src/renderer/state/stores/ui";

const ratio = () => useUIStore.getState().agentListRatio;

describe("the agent list's list share", () => {
  test("is the default until dragged, and what it was dragged to after", () => {
    useUIStore.getState().hydrate({});
    expect(ratio()).toBeNull();
    useUIStore.getState().setAgentListRatio(0.35);
    expect(ratio()).toBe(0.35);
  });

  test("stays between its least and most", () => {
    useUIStore.getState().setAgentListRatio(0.01);
    expect(ratio()).toBe(AGENT_LIST_RATIO_MIN);
    useUIStore.getState().setAgentListRatio(0.99);
    expect(ratio()).toBe(AGENT_LIST_RATIO_MAX);
  });

  test("goes back to the default, and is restored as stored", () => {
    useUIStore.getState().setAgentListRatio(null);
    expect(ratio()).toBeNull();
    useUIStore.getState().hydrate({ agentListRatio: 0.6 });
    expect(ratio()).toBe(0.6);
    useUIStore.getState().hydrate({ agentListRatio: null });
    expect(ratio()).toBeNull();
    useUIStore.getState().hydrate({ agentListRatio: Number.NaN });
    expect(ratio()).toBeNull();
  });
});
