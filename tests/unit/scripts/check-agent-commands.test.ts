import { describe, expect, test } from "bun:test";
import {
  claudeCommandsIn,
  codexCommandsIn,
  codexMethodsIn,
  codexServiceTierCommandsIn,
} from "../../../scripts/check-agent-commands";

describe("Claude Code's commands, as its bundle defines them", () => {
  test("the type before the name, with aliases; one turned off is told", () => {
    const bundle =
      'var a={type:"local-jsx",name:"mobile",aliases:["ios","android"],description:"QR"},b=a;' +
      'var c={isEnabled:()=>!1,isHidden:!0,name:"stub"};' +
      'var v={type:"local-jsx",name:"version",description:"v",isEnabled:()=>!1,immediate:!0};';
    expect(claudeCommandsIn(bundle)).toEqual([
      { name: "mobile", aliases: ["ios", "android"] },
      { name: "version", aliases: [], off: true },
    ]);
  });

  test("the name before the type, a description's getter between", () => {
    const bundle =
      'var s={name:"sandbox",get description(){let e=f();return e?"on":"off"},type:"local-jsx"};';
    expect(claudeCommandsIn(bundle)).toEqual([{ name: "sandbox", aliases: [] }]);
  });
});

describe("Codex's commands, from its SlashCommand enum", () => {
  test("kebab-cased variants, unless strum names them", () => {
    const source = `
pub enum SlashCommand {
    // DO NOT ALPHA-SORT!
    Model,
    #[strum(serialize = "setup-default-sandbox")]
    ElevateSandbox,
    DebugConfig,
    #[strum(to_string = "pwd", serialize = "cwd")]
    Pwd,
}`;
    expect(codexCommandsIn(source)).toEqual([
      { name: "model", aliases: [] },
      { name: "setup-default-sandbox", aliases: [] },
      { name: "debug-config", aliases: [] },
      { name: "pwd", aliases: ["cwd"] },
    ]);
  });
});

describe("Codex's model-dependent slash commands", () => {
  test("derives each lowercased display name once, rather than assuming Fast is available", () => {
    const catalog = JSON.stringify({
      models: [
        { service_tiers: [{ id: "priority", name: "Fast" }] },
        {
          service_tiers: [
            { id: "priority", name: "FAST" },
            { id: "flex", name: "Flex" },
          ],
        },
        { service_tiers: [] },
      ],
    });
    expect(codexServiceTierCommandsIn(catalog)).toEqual([
      { name: "fast", aliases: [] },
      { name: "flex", aliases: [] },
    ]);
    expect(codexServiceTierCommandsIn('{"models":[{"service_tiers":[]}]}')).toEqual([]);
  });
});

describe("Codex app-server method schemas", () => {
  test("reads actual variant discriminants and skips nested or unreferenced method names", () => {
    const schema = JSON.stringify({
      oneOf: [
        {
          properties: {
            method: { enum: ["thread/settings/update"] },
            params: { properties: { method: { enum: ["unrelated/nested"] } } },
          },
        },
        { properties: { method: { const: "collaborationMode/list" } } },
      ],
      definitions: {
        nested: { properties: { method: { enum: ["unrelated/definition"] } } },
      },
    });
    expect([...codexMethodsIn(schema)]).toEqual([
      "thread/settings/update",
      "collaborationMode/list",
    ]);
    expect(() => codexMethodsIn('{"oneOf":[{"properties":{"method":{"type":"string"}}}]}')).toThrow(
      "no method discriminant",
    );
  });
});
