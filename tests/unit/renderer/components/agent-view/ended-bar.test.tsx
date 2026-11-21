import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EndedBar } from "../../../../../src/renderer/components/agent-view/ended-bar";
import { resumeInTerminal } from "../../../../../src/renderer/services/agent-view/resume-terminal";
import { registerTerminalController } from "../../../../../src/renderer/services/terminal/terminal-registry";
import type {
  TerminalController,
  TerminalInputCheckpoint,
} from "../../../../../src/renderer/services/terminal/types";

const ended = { agent: "claude", sessionId: "resume-id", prompted: true } as const;
const line = "claude --resume resume-id";

function shell(tabId: string) {
  const terminal = { workspaceId: "resume-workspace", tabId };
  const submitted: string[] = [];
  let checkpoint: TerminalInputCheckpoint = { hasInput: false };
  let draft = "";
  const unregister = registerTerminalController(tabId, {
    getInputCheckpoint: () => checkpoint,
    input(data: string, mode: string) {
      expect(mode).toBe("keys");
      expect(data.endsWith("\r")).toBe(true);
      submitted.push(draft + data.slice(0, -1));
      checkpoint = { hasInput: true };
      return true;
    },
    whenReady: async () => true,
  } as unknown as TerminalController);
  return {
    terminal,
    checkpoint,
    submitted,
    type(text: string) {
      draft += text;
      checkpoint = { hasInput: true };
    },
    unregister,
  };
}

test("a finished agent can submit its resume command when the user has not typed", async () => {
  const { terminal, checkpoint, submitted, unregister } = shell("clean-resume-terminal");
  try {
    const html = renderToStaticMarkup(
      <EndedBar ended={ended} terminal={terminal} checkpoint={checkpoint} />,
    );
    expect(html).toContain("<button");
    expect(html).not.toContain("<code");

    await resumeInTerminal(terminal, line, checkpoint);
    expect(submitted).toEqual([line]);
  } finally {
    unregister();
  }
});

test("after typing, the resume command is selectable and a stale click does not submit it", async () => {
  const { terminal, checkpoint, submitted, type, unregister } = shell("dirty-resume-terminal");
  try {
    type("echo ");
    const html = renderToStaticMarkup(
      <EndedBar ended={ended} terminal={terminal} checkpoint={checkpoint} />,
    );
    expect(html).toMatch(/<code[^>]+select-text[^>]*>claude --resume resume-id<\/code>/);
    expect(html).not.toContain("<button");

    await resumeInTerminal(terminal, line, checkpoint);
    expect(submitted).toEqual([]);
  } finally {
    unregister();
  }
});

test("typing while resume waits for the terminal cancels the submission", async () => {
  const { terminal, checkpoint, submitted, type, unregister } = shell("waiting-resume-terminal");
  try {
    const resuming = resumeInTerminal(terminal, line, checkpoint);
    type("echo ");
    await resuming;
    expect(submitted).toEqual([]);
  } finally {
    unregister();
  }
});

test("a restored banner with no checkpoint offers a selectable command", () => {
  const { terminal, unregister } = shell("restored-resume-terminal");
  try {
    const html = renderToStaticMarkup(<EndedBar ended={ended} terminal={terminal} />);
    expect(html).toContain("<code");
    expect(html).not.toContain("<button");
  } finally {
    unregister();
  }
});

test("a finished agent without a supported command shows only its status", () => {
  const html = renderToStaticMarkup(
    <EndedBar
      ended={{ agent: undefined, sessionId: undefined, prompted: false }}
      terminal={{ workspaceId: "resume-workspace", tabId: "unsupported-agent-terminal" }}
    />,
  );
  expect(html).toContain('role="status"');
  expect(html).not.toContain("<code");
  expect(html).not.toContain("<button");
});
