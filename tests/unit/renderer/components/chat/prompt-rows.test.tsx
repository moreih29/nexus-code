/**
 * What the user told Claude when it asked, as the conversation keeps it:
 * the questions with the answers picked, and the plan with how it went.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AnsweredQuestions,
  answersOf,
  declineReason,
  PlanOutcome,
  showsAsPrompt,
} from "../../../../../src/renderer/components/chat/prompt-rows";
import type { ToolCall } from "../../../../../src/renderer/services/chat/model";

const QUESTIONS = {
  questions: [
    {
      question: "Which color do you prefer?",
      header: "Color",
      options: [{ label: "Red" }, { label: "Blue" }],
      multiSelect: false,
    },
    {
      question: "Which operating systems do you use?",
      header: "OS",
      options: [{ label: "macOS" }, { label: "Linux" }],
      multiSelect: true,
    },
  ],
};

function call(over: Partial<ToolCall>): ToolCall {
  return {
    id: "t1",
    name: "AskUserQuestion",
    input: QUESTIONS,
    status: "done",
    parentToolUseId: null,
    ...over,
  };
}

const result = (text: string, structured?: unknown) => ({
  text,
  isError: false,
  images: [],
  ...(structured !== undefined ? { structured } : {}),
});

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("showsAsPrompt", () => {
  it("takes the calls that ask, unless the tool itself failed", () => {
    expect(showsAsPrompt(call({}))).toBe(true);
    expect(showsAsPrompt(call({ name: "ExitPlanMode", status: "denied" }))).toBe(true);
    // A no read back from the transcript is an error in the user's words.
    expect(showsAsPrompt(call({ status: "error", result: result("not now") }))).toBe(true);
    expect(
      showsAsPrompt(
        call({
          name: "ExitPlanMode",
          status: "error",
          result: result("<tool_use_error>You are not in plan mode.</tool_use_error>"),
        }),
      ),
    ).toBe(false);
    expect(showsAsPrompt(call({ name: "Bash" }))).toBe(false);
    expect(showsAsPrompt(undefined)).toBe(false);
  });
});

describe("answersOf", () => {
  it("reads the CLI's answers, else the answer's text", () => {
    const answers = { "Which color do you prefer?": "Blue" };
    expect(answersOf(call({ result: result("", { questions: [], answers }) }))).toEqual(answers);
    expect(
      answersOf(
        call({
          result: result(
            'Your questions have been answered: "Which color do you prefer?"="Blue", "Which operating systems do you use?"="macOS, Linux". You can now continue.',
          ),
        }),
      ),
    ).toEqual({
      "Which color do you prefer?": "Blue",
      "Which operating systems do you use?": "macOS, Linux",
    });
  });
});

describe("declineReason", () => {
  it("drops what the CLI added to the user's words", () => {
    const tool = call({
      status: "error",
      result: result("Name it memo.txt instead\n\n<system-reminder>\nleft\n</system-reminder>"),
    });
    expect(declineReason(tool)).toBe("Name it memo.txt instead");
  });
});

describe("AnsweredQuestions", () => {
  it("lists each question with its answer", () => {
    const html = renderToStaticMarkup(
      <AnsweredQuestions
        tool={call({
          result: result("", {
            answers: { "Which color do you prefer?": "Blue" },
          }),
        })}
      />,
    );
    expect(text(html)).toBe(
      "Which color do you prefer? Blue Which operating systems do you use? No answer",
    );
  });

  it("says when the questions were skipped or still wait", () => {
    expect(
      text(renderToStaticMarkup(<AnsweredQuestions tool={call({ status: "denied" })} />)),
    ).toBe("Questions skipped Which color do you prefer?");
    expect(
      text(renderToStaticMarkup(<AnsweredQuestions tool={call({ status: "running" })} />)),
    ).toBe("Waiting for an answer Which color do you prefer?");
  });
});

describe("PlanOutcome", () => {
  const plan = (over: Partial<ToolCall>) =>
    renderToStaticMarkup(
      <PlanOutcome
        tool={call({
          name: "ExitPlanMode",
          input: { plan: "# Add `goodbye.txt`\n\nWrite it." },
          ...over,
        })}
        workspaceId="w"
        cwd="/w"
        rootPath="/w"
      />,
    );

  it("names the plan by its first line, folded", () => {
    expect(text(plan({}))).toBe("Plan approved Add goodbye.txt");
  });

  it("shows what the user asked to change", () => {
    expect(text(plan({ status: "error", result: result("Use bye.txt instead") }))).toBe(
      "Changes requested Add goodbye.txt Use bye.txt instead",
    );
  });
});
