import { describe, expect, test } from "bun:test";
import { claudeCommandsIn, codexCommandsIn } from "../../../scripts/check-agent-commands";

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
