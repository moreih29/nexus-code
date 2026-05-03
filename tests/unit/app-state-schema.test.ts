import { describe, expect, it } from "bun:test";
import { AppStateSchema } from "../../src/shared/types/appState";

describe("AppStateSchema — backward-compat: filesPanelCollapsed key", () => {
  it("parse({filesPanelCollapsed:true}) succeeds and strips the unknown key", () => {
    const result = AppStateSchema.parse({ filesPanelCollapsed: true });
    expect(result).not.toHaveProperty("filesPanelCollapsed");
  });

  it("safeParse({filesPanelCollapsed:false}) returns success:true", () => {
    const result = AppStateSchema.safeParse({ filesPanelCollapsed: false });
    expect(result.success).toBe(true);
  });
});
