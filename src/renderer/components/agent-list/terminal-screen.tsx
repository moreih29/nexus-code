// Agent list — a terminal's screen in the detail panel: its last lines, read
// every second while shown, each drawn by what it is. Folded away when the
// terminal's hooks tell the rest.

import { ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { AgentSession } from "../../services/agent-sessions/model";
import { type ScreenLineKind, screenLines } from "../../services/agent-sessions/screen-lines";
import { getTerminalController } from "../../services/terminal/terminal-registry";

const SCREEN_LINES = 20;
const SCREEN_POLL_MS = 1_000;

/** The screen of `session`'s terminal, open at first unless its hooks tell what it does. */
export function TerminalScreen({
  session,
  told,
  visible,
}: {
  session: AgentSession;
  /** Its hooks tell what it does: the screen starts folded. */
  told: boolean;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const [toggled, setToggled] = useState<boolean | undefined>(undefined);
  const open = toggled ?? !told;
  const screen = useTerminalScreen(session.tabId, visible && open);
  return (
    <section className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setToggled(!open)}
        aria-expanded={open}
        className="flex items-center gap-1 self-start rounded-(--radius-control) text-app-label uppercase text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        {open ? t("agentList.detail.screen_hide") : t("agentList.detail.screen_show")}
      </button>
      {open &&
        (screen === null ? (
          <p className="text-app-ui-sm text-muted-foreground">
            {session.state === "exited"
              ? t("agentList.detail.screen_exited")
              : t("agentList.detail.screen_not_started")}
          </p>
        ) : (
          // Keyed by the session, so each one opens scrolled to its latest lines.
          <ScreenText key={session.key} text={screen} />
        ))}
    </section>
  );
}

// How each kind of screen line is drawn.
const LINE_CLASS: Record<ScreenLineKind, string> = {
  item: "text-foreground",
  result: "text-muted-foreground",
  added: "bg-emerald-500/10 text-emerald-500",
  removed: "bg-(--state-error-fg)/10 text-(--state-error-fg)",
  status: "text-(--tab-claude-attention-fg)",
  prompt: "text-foreground",
  rule: "",
  hint: "text-muted-foreground/70",
  blank: "",
  text: "text-foreground/90",
};

/**
 * The screen's lines, kept scrolled to the latest unless scrolled up, each
 * drawn by what it is: a tool call's bullet stands out, its result is
 * dimmed, a diff's lines are tinted, the agent's rules become thin lines.
 * It takes focus, so the keyboard can scroll it too.
 */
function ScreenText({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll again whenever the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={ref}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region the keyboard must reach
      tabIndex={0}
      onScroll={(event) => {
        const el = event.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
      className="app-scrollbar max-h-80 overflow-y-auto whitespace-pre-wrap break-all rounded-(--radius-control) border border-border bg-background px-2 py-1.5 font-mono text-app-micro leading-relaxed text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {screenLines(text).map((line, index) =>
        line.kind === "rule" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a screen's lines have no identity but their place
          <span key={index} aria-hidden className="my-1 block h-px bg-border" />
        ) : (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: a screen's lines have no identity but their place
            key={index}
            className={cn(
              "block min-h-[1lh]",
              LINE_CLASS[line.kind],
              line.kind === "item" && "mt-1 first:mt-0",
            )}
          >
            {line.kind === "item" ? <ItemLine text={line.text} /> : line.text}
          </span>
        ),
      )}
    </pre>
  );
}

/** A tool call or message line: its bullet in the agent's color, then its words. */
function ItemLine({ text }: { text: string }) {
  const match = /^(\s*)([⏺●◆])(\s.*)$/.exec(text);
  if (!match) return <>{text}</>;
  return (
    <>
      {match[1]}
      <span className="text-emerald-500">{match[2]}</span>
      {match[3]}
    </>
  );
}

/** The last lines of a terminal's screen, read every second while `visible`. */
function useTerminalScreen(tabId: string, visible: boolean): string | null {
  const [screen, setScreen] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    const read = () => {
      const controller = getTerminalController(tabId);
      if (!controller) {
        setScreen(null);
        return;
      }
      const lines = controller
        .readText(SCREEN_LINES * 2)
        .replace(/\s+$/, "")
        .split("\n");
      setScreen(lines.slice(-SCREEN_LINES).join("\n"));
    };
    read();
    const timer = setInterval(read, SCREEN_POLL_MS);
    return () => clearInterval(timer);
  }, [tabId, visible]);
  return screen;
}
