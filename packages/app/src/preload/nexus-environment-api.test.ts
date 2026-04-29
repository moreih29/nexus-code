import { describe, expect, test } from "bun:test";

import { createNexusEnvironmentApi } from "./nexus-environment-api";

describe("createNexusEnvironmentApi", () => {
  test("exposes the renderer platform value", () => {
    expect(createNexusEnvironmentApi("darwin")).toEqual({ platform: "darwin" });
    expect(createNexusEnvironmentApi("win32")).toEqual({ platform: "win32" });
  });
});
