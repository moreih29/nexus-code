// What each Claude Code session is doing, as its hooks tell it: the tools
// its turn runs, its todo list, and the subagents working beside it, each
// with the tools it runs. The sessions tab reads it (claude.activity).
//
// A subagent is told twice: the Agent tool call that starts it (what it was
// asked, PreToolUse) and its own start (its id, SubagentStart). Claude Code
// 2.1 gives the id in the Agent tool's answer of a background agent, which
// comes before the agent starts; a foreground agent starts before the tool
// answers, and is matched to the oldest call for its type.
//
// A `claude -p` run started inside the session, as by a script its Bash tool
// runs, has no hooks: the agent runs it and tells of it (hookclient's
// print-run), and it is one of the session's agents. So is a `codex exec`
// run (hookclient's exec-run), told the same, as codex's. One killed before
// it tells its end is told gone by the agent, and reads stopped. A run that
// goes on an ended run's session (`claude -p --resume <id>`, `codex exec
// resume <id>`) is that run going on. While a run goes on, the app holds its
// watch, whose answer stops it.

import {
  ACTIVITY_TEXT_MAX_CHARS,
  AGENT_TOOLS_KEPT,
  type AgentRun,
  type AgentRunState,
  ENDED_AGENTS_KEPT,
  SESSION_TOOLS_KEPT,
  type SessionActivity,
  type Todo,
  type ToolRun,
} from "../../../shared/claude/activity";

/** The tools that start a subagent: "Agent", "Task" before Claude Code 2.1. */
const AGENT_TOOLS = new Set(["Agent", "Task"]);
/** How many Agent tool calls wait for their agent at most; a call whose agent never starts is dropped. */
const AGENT_CALLS_KEPT = 16;
/** The tools that run a command, which may start a `claude -p` run. */
const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);
/** The tools that write files, and the field naming the file. */
const WRITING_TOOLS: Readonly<Record<string, string>> = {
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

/** An Agent tool call whose agent has not started yet. */
interface AgentCall {
  readonly type: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly background?: boolean;
  readonly model?: string;
}

interface AgentEntry extends Omit<AgentRun, "tools"> {
  tools: ToolRun[];
  /** The call its open permission dialog is for, as callKey gives it. */
  asking?: string;
  /** A `claude -p` run's directory, which its tools' paths are told from. */
  cwd?: string;
  /** The hook a running `claude -p` run holds open, whose answer stops it. */
  watch?: string;
}

interface SessionEntry {
  readonly workspaceId: string;
  readonly tabId: string;
  sessionId?: string;
  cwd?: string;
  turnStart?: number;
  tools: ToolRun[];
  toolCount: number;
  failedCount: number;
  files: string[];
  todos: Todo[];
  agents: Map<string, AgentEntry>;
  /** Agent tool calls not matched to their agent yet, oldest first. */
  calls: AgentCall[];
  /** Agent tool calls whose agent's id the tool's answer told. */
  callsByAgent: Map<string, AgentCall>;
  /** The `claude -p` runs that went on an earlier run, by run id: that run's agent id. */
  runs: Map<string, string>;
}

/** Called as an agent starts, changes state and ends. */
export type AgentListener = (workspaceId: string, tabId: string, agent: AgentRun) => void;

type Payload = Record<string, unknown>;

export class SessionActivityLog {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly listeners = new Set<AgentListener>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Records what a Claude Code hook of the session in `tabId` tells. */
  noteHook(workspaceId: string, tabId: string, subcommand: string, payload: unknown): void {
    const p: Payload = typeof payload === "object" && payload !== null ? (payload as Payload) : {};
    const key = `${workspaceId}:${tabId}`;
    if (subcommand === "session-end") {
      this.drop(key);
      return;
    }
    if (subcommand === "session-start") {
      // Compaction starts no session: the turn goes on after it.
      if (p.source !== "compact") this.drop(key);
    }
    const session = this.sessionOf(workspaceId, tabId);
    if (typeof p.cwd === "string" && p.cwd !== "") session.cwd = p.cwd;
    if (typeof p.session_id === "string" && p.session_id !== "") session.sessionId = p.session_id;
    const agentId = typeof p.agent_id === "string" && p.agent_id !== "" ? p.agent_id : undefined;

    switch (subcommand) {
      case "user-prompt-submit":
        this.endOpenTools(session.tools);
        this.endForegroundAgents(session);
        session.turnStart = this.now();
        session.toolCount = 0;
        session.failedCount = 0;
        session.files = [];
        break;
      case "stop":
      case "stop-failure":
        // A tool the turn left without an end was interrupted.
        this.endOpenTools(session.tools);
        break;
      case "pre-tool-use":
        this.toolStarted(session, agentId, p);
        break;
      case "post-tool-use":
      case "post-tool-use-failure":
        this.toolEnded(session, agentId, p, subcommand === "post-tool-use-failure");
        break;
      case "permission-request":
        if (agentId) {
          const agent = this.agentOf(session, agentId, p);
          agent.asking = callKey(p);
          this.setAgentState(session, agent, "permissionPending");
        }
        break;
      case "subagent-start":
        if (agentId) this.agentOf(session, agentId, p);
        break;
      case "subagent-stop":
        if (agentId) {
          const agent = this.agentOf(session, agentId, p);
          const answer = text(p.last_assistant_message);
          if (answer !== undefined) agent.answer = answer;
          agent.end = this.now();
          agent.asking = undefined;
          this.endOpenTools(agent.tools);
          this.setAgentState(session, agent, "completed", true);
          this.pruneAgents(session);
        }
        break;
    }
  }

  /**
   * Records what a `claude -p` run started inside the session in `tabId`
   * tells of itself (hookclient's print-run): its start, claude's start, the
   * tools it runs and how they end, and its own end; or that it is gone,
   * told by the agent once its watch closed, which ends one that told no
   * end as stopped.
   */
  notePrint(workspaceId: string, tabId: string, frame: string, payload: unknown): void {
    const p = record(payload);
    const id = text(p.run_id);
    if (id === undefined) return;
    const session = this.sessionOf(workspaceId, tabId);
    if (frame === "print-start") {
      if (session.agents.has(id) || session.runs.has(id)) return;
      const earlier =
        p.resumed === true ? this.endedPrintOf(session, text(p.session_id)) : undefined;
      if (earlier) this.printResumed(session, earlier, id, p);
      else this.printStarted(session, id, p);
      return;
    }
    const run = this.printRunOf(session, id);
    if (run === undefined || run.end !== undefined) return;
    switch (frame) {
      case "print-init": {
        const model = text(p.model);
        if (model !== undefined) run.model = model;
        run.endpoint = text(p.endpoint) ?? run.endpoint;
        run.cwd = text(p.cwd) ?? run.cwd;
        run.sessionId ??= text(p.session_id);
        // Told from the transcript when its arguments did not tell it.
        run.prompt = text(p.prompt) ?? run.prompt;
        // A run that tells its tools in its transcript tells it once it is found.
        if (p.tools_told === true) run.toolsTold = true;
        break;
      }
      case "print-tool-use": {
        const name = text(p.tool_name);
        if (name === undefined) break;
        const input = record(p.tool_input);
        push(
          run.tools,
          {
            id: text(p.tool_use_id) ?? `${name}:${this.now()}`,
            name,
            ...describeTool(name, input, run.cwd ?? session.cwd),
            start: this.now(),
            ...(input.run_in_background === true ? { background: true } : {}),
          },
          AGENT_TOOLS_KEPT,
        );
        run.toolCount++;
        break;
      }
      case "print-tool-result": {
        const toolId = text(p.tool_use_id);
        const tool = run.tools.find((tool) => tool.id === toolId);
        if (!tool || tool.end !== undefined) break;
        tool.end = this.now();
        if (p.is_error === true) {
          tool.failed = true;
          const error = firstLine(text(p.error));
          if (error !== undefined) tool.error = error;
          run.failedCount++;
        }
        break;
      }
      case "print-end": {
        const answer = text(p.answer);
        if (answer !== undefined) run.answer = answer;
        const code = p.exit_code;
        if (typeof code === "number" && Number.isInteger(code)) run.exitCode = code;
        run.end = this.now();
        run.watch = undefined;
        this.endOpenTools(run.tools);
        // Stopped by a signal, as with the turn that ran it.
        const state =
          text(p.signal) !== undefined ? "stopped" : run.exitCode === 0 ? "completed" : "failed";
        this.setAgentState(session, run, state, true);
        this.pruneAgents(session);
        break;
      }
      case "print-gone":
        this.stopAgent(session, run);
        this.pruneAgents(session);
        break;
    }
  }

  /**
   * A `claude -p` run of the session in `tabId` holds its watch open
   * (hookclient's print-run): the hook `hookId`, whose answer stops it.
   */
  notePrintWatch(workspaceId: string, tabId: string, runId: string, hookId: string): void {
    const session = this.sessions.get(`${workspaceId}:${tabId}`);
    const run = session && this.printRunOf(session, runId);
    if (run !== undefined && run.end === undefined) run.watch = hookId;
  }

  /**
   * The watch of the session's running `claude -p` run `agentId`, whose
   * answer stops it; undefined for a subagent, or a run over or not watched.
   */
  printWatch(workspaceId: string, tabId: string, agentId: string): string | undefined {
    const agent = this.sessions.get(`${workspaceId}:${tabId}`)?.agents.get(agentId);
    return agent?.kind === "print" && agent.end === undefined ? agent.watch : undefined;
  }

  /**
   * The user answered a permission request of the session's turn, or of
   * `agentId`, from the app, for the call to `tool` on `target`: the agent
   * goes on, with the call or past it, and a denied call never runs. No hook
   * tells either.
   */
  noteAnswered(
    workspaceId: string,
    tabId: string,
    agentId: string | undefined,
    tool: string,
    target: string | undefined,
    denied: boolean,
  ): void {
    const session = this.sessions.get(`${workspaceId}:${tabId}`);
    if (!session) return;
    const agent = agentId === undefined ? undefined : session.agents.get(agentId);
    if (denied) {
      const tools = agent ? agent.tools : session.tools;
      const run = [...tools]
        .reverse()
        .find((run) => run.end === undefined && run.name === tool && run.target === target);
      if (run) {
        run.end = this.now();
        run.denied = true;
      }
    }
    if (agent?.state !== "permissionPending") return;
    agent.asking = undefined;
    this.setAgentState(session, agent, "running");
  }

  /**
   * The session's turn is over though no hook said so, as when the user
   * interrupts it: a tool it left running was stopped with it.
   */
  noteTurnOver(workspaceId: string, tabId: string): void {
    const session = this.sessions.get(`${workspaceId}:${tabId}`);
    if (session) this.endOpenTools(session.tools);
  }

  /** What the session in `tabId` is doing, or null when no hook told anything. */
  get(workspaceId: string, tabId: string): SessionActivity | null {
    const session = this.sessions.get(`${workspaceId}:${tabId}`);
    return session ? snapshotOf(session) : null;
  }

  /** What the sessions of `workspaceIds` are doing. */
  list(workspaceIds: readonly string[]): SessionActivity[] {
    const wanted = new Set(workspaceIds);
    return [...this.sessions.values()]
      .filter((session) => wanted.has(session.workspaceId))
      .map(snapshotOf);
  }

  /** Forgets the session in a terminal that ended. */
  clear(workspaceId: string, tabId: string): void {
    this.drop(`${workspaceId}:${tabId}`);
  }

  /** Forgets the sessions of a workspace, as its Claude states are cleared. */
  clearWorkspace(workspaceId: string): void {
    for (const [key, session] of this.sessions) {
      if (session.workspaceId === workspaceId) this.drop(key);
    }
  }

  /** Calls `listener` as agents start, change state and end; the returned function stops it. */
  onAgentChange(listener: AgentListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private sessionOf(workspaceId: string, tabId: string): SessionEntry {
    const key = `${workspaceId}:${tabId}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        workspaceId,
        tabId,
        tools: [],
        toolCount: 0,
        failedCount: 0,
        files: [],
        todos: [],
        agents: new Map(),
        calls: [],
        callsByAgent: new Map(),
        runs: new Map(),
      };
      this.sessions.set(key, session);
    }
    return session;
  }

  /**
   * The agent `agentId`, started now if no hook told of it yet: its
   * SubagentStart, or, when that never came, the first hook it ran.
   */
  private agentOf(session: SessionEntry, agentId: string, p: Payload): AgentEntry {
    const known = session.agents.get(agentId);
    if (known) return known;
    const type = text(p.agent_type) ?? "general-purpose";
    const call = session.callsByAgent.get(agentId) ?? takeCall(session.calls, type);
    session.callsByAgent.delete(agentId);
    const agent: AgentEntry = {
      id: agentId,
      kind: "subagent",
      type,
      ...(call?.model !== undefined ? { model: call.model } : {}),
      ...(call?.description !== undefined ? { description: call.description } : {}),
      ...(call?.prompt !== undefined ? { prompt: call.prompt } : {}),
      ...(call?.background ? { background: true } : {}),
      start: this.now(),
      state: "running",
      tools: [],
      toolCount: 0,
      failedCount: 0,
    };
    session.agents.set(agentId, agent);
    this.emit(session, agent);
    return agent;
  }

  /**
   * A `claude -p` run started, by the command the session (or one of its
   * subagents) runs now: what that command was said to do tells the run.
   */
  private printStarted(session: SessionEntry, id: string, p: Payload): void {
    const command = latest(
      [session.tools, ...[...session.agents.values()].map((agent) => agent.tools)]
        .flat()
        // A command left in the background answers as it starts, before the run tells of it.
        .filter(
          (tool) => COMMAND_TOOLS.has(tool.name) && (tool.end === undefined || tool.background),
        ),
    );
    const run: AgentEntry = {
      id,
      kind: "print",
      ...(p.program === "codex" ? { program: "codex" as const } : {}),
      ...optional("model", text(p.model)),
      ...optional("endpoint", text(p.endpoint)),
      ...optional("description", command?.note),
      ...optional("prompt", text(p.prompt)),
      start: this.now(),
      state: "running",
      tools: [],
      toolCount: 0,
      failedCount: 0,
      toolsTold: p.tools_told === true,
      ...optional("sessionId", text(p.session_id)),
      ...optional("cwd", text(p.cwd)),
    };
    session.agents.set(id, run);
    this.emit(session, run);
  }

  /** The `claude -p` run `runId` is, as itself or as the earlier run it went on. */
  private printRunOf(session: SessionEntry, runId: string): AgentEntry | undefined {
    const run = session.agents.get(session.runs.get(runId) ?? runId);
    return run?.kind === "print" ? run : undefined;
  }

  /** The latest ended `claude -p` run of the Claude session `sessionId`. */
  private endedPrintOf(
    session: SessionEntry,
    sessionId: string | undefined,
  ): AgentEntry | undefined {
    if (sessionId === undefined) return undefined;
    return latestBy(
      [...session.agents.values()].filter(
        (agent) =>
          agent.kind === "print" && agent.sessionId === sessionId && agent.end !== undefined,
      ),
      (agent) => agent.end ?? 0,
    );
  }

  /**
   * A `claude -p` run `runId` went on the Claude session of the ended run
   * `run`: that run goes on, asked anew, its tools kept.
   */
  private printResumed(session: SessionEntry, run: AgentEntry, runId: string, p: Payload): void {
    session.runs.set(runId, run.id);
    const prompt = text(p.prompt);
    if (prompt !== undefined) run.prompt = prompt;
    run.model = text(p.model) ?? run.model;
    run.endpoint = text(p.endpoint) ?? run.endpoint;
    run.cwd = text(p.cwd) ?? run.cwd;
    run.toolsTold = p.tools_told === true;
    delete run.end;
    delete run.answer;
    delete run.exitCode;
    run.watch = undefined;
    this.setAgentState(session, run, "running", true);
  }

  private toolStarted(session: SessionEntry, agentId: string | undefined, p: Payload): void {
    const name = text(p.tool_name);
    if (name === undefined) return;
    const input = record(p.tool_input);
    const run: ToolRun = {
      id: text(p.tool_use_id) ?? `${name}:${this.now()}`,
      name,
      ...describeTool(name, input, session.cwd),
      start: this.now(),
      ...(input.run_in_background === true ? { background: true } : {}),
    };
    if (agentId) {
      const agent = this.agentOf(session, agentId, p);
      push(agent.tools, run, AGENT_TOOLS_KEPT);
      agent.toolCount++;
      // An agent that goes on to another call is past its dialog.
      if (agent.state === "permissionPending" && agent.asking !== callKey(p)) {
        agent.asking = undefined;
        this.setAgentState(session, agent, "running");
      }
    } else {
      push(session.tools, run, SESSION_TOOLS_KEPT);
      session.toolCount++;
      // A subagent keeps its own todo list; the task list is the session's.
      if (name === "TodoWrite") session.todos = todosOf(input.todos) ?? session.todos;
    }
    if (name === "TaskUpdate") session.todos = updateTodo(session.todos, input);
    if (AGENT_TOOLS.has(name)) {
      if (session.calls.length >= AGENT_CALLS_KEPT) session.calls.shift();
      session.calls.push({
        type: text(input.subagent_type) ?? "general-purpose",
        ...optional("description", text(input.description)),
        ...optional("prompt", text(input.prompt)),
        ...optional("model", text(input.model)),
        ...(input.run_in_background === true ? { background: true } : {}),
      });
    }
  }

  private toolEnded(
    session: SessionEntry,
    agentId: string | undefined,
    p: Payload,
    failed: boolean,
  ): void {
    const name = text(p.tool_name);
    const id = text(p.tool_use_id);
    const agent = agentId ? this.agentOf(session, agentId, p) : undefined;
    const tools = agent ? agent.tools : session.tools;
    const run = id === undefined ? undefined : tools.find((tool) => tool.id === id);
    if (run && run.end === undefined) {
      run.end = this.now();
      if (failed) {
        run.failed = true;
        const error = firstLine(text(p.error));
        if (error !== undefined) run.error = error;
        if (agent) agent.failedCount++;
        else session.failedCount++;
      }
    }
    if (agent?.state === "permissionPending" && agent.asking === callKey(p)) {
      agent.asking = undefined;
      this.setAgentState(session, agent, "running");
    }
    if (name === undefined) return;
    const input = record(p.tool_input);
    if (failed) {
      // An agent the tool failed to start never will.
      if (AGENT_TOOLS.has(name)) {
        const type = text(input.subagent_type) ?? "general-purpose";
        const description = text(input.description);
        const index = session.calls.findIndex(
          (call) => call.type === type && call.description === description,
        );
        if (index !== -1) session.calls.splice(index, 1);
      }
      return;
    }
    const response = record(p.tool_response);
    const field = WRITING_TOOLS[name];
    const file = field ? text(input[field]) : undefined;
    if (file !== undefined) {
      const shown = relative(file, session.cwd);
      if (!session.files.includes(shown)) session.files.push(shown);
    }
    if (AGENT_TOOLS.has(name)) this.agentToolAnswered(session, input, response);
    if (name === "TaskCreate") {
      const task = record(response.task);
      const subject = text(input.subject) ?? text(task.subject);
      if (subject !== undefined) {
        session.todos = [
          ...session.todos,
          {
            ...optional("id", text(task.id)),
            content: subject,
            ...optional("activeForm", text(input.activeForm)),
            status: "pending",
          },
        ];
      }
    }
  }

  /**
   * The Agent tool answered: a background agent's answer names it, before
   * it starts. Its call is kept for it by that id.
   */
  private agentToolAnswered(session: SessionEntry, input: Payload, response: Payload): void {
    const agentId = text(response.agentId);
    if (agentId === undefined) return;
    const model = text(response.resolvedModel);
    const started = session.agents.get(agentId);
    if (started) {
      // A foreground agent the user sent to the background.
      if (response.status === "async_launched") started.background = true;
      if (model !== undefined) started.model = model;
      return;
    }
    const type = text(input.subagent_type) ?? "general-purpose";
    const call = takeCall(session.calls, type, text(input.description));
    if (call) session.callsByAgent.set(agentId, model ? { ...call, model } : call);
  }

  private setAgentState(
    session: SessionEntry,
    agent: AgentEntry,
    state: AgentRunState,
    force = false,
  ): void {
    if (agent.state === state && !force) return;
    agent.state = state;
    this.emit(session, agent);
  }

  private emit(session: SessionEntry, agent: AgentEntry): void {
    const run = agentRunOf(agent);
    for (const listener of this.listeners) listener(session.workspaceId, session.tabId, run);
  }

  private endOpenTools(tools: ToolRun[]): void {
    const now = this.now();
    for (const tool of tools) if (tool.end === undefined && !tool.background) tool.end = now;
  }

  /**
   * A new turn: a foreground agent of the last one that told no end was
   * stopped with it, as by an interrupt. A `claude -p` run tells its own
   * end, and may outlive the command that started it.
   */
  private endForegroundAgents(session: SessionEntry): void {
    for (const agent of session.agents.values()) {
      if (agent.end === undefined && !agent.background && agent.kind !== "print") {
        this.stopAgent(session, agent);
      }
    }
    this.pruneAgents(session);
  }

  /** Forgets a session; the agents it still ran stopped with it. */
  private drop(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    for (const agent of session.agents.values()) {
      if (agent.end === undefined) this.stopAgent(session, agent);
    }
  }

  private stopAgent(session: SessionEntry, agent: AgentEntry): void {
    agent.end = this.now();
    agent.asking = undefined;
    agent.watch = undefined;
    this.endOpenTools(agent.tools);
    this.setAgentState(session, agent, "stopped", true);
  }

  /** Keeps the running agents and the latest ended ones. */
  private pruneAgents(session: SessionEntry): void {
    const ended = [...session.agents.values()]
      .filter((agent) => agent.end !== undefined)
      .sort((a, b) => (b.end ?? 0) - (a.end ?? 0));
    for (const agent of ended.slice(ENDED_AGENTS_KEPT)) session.agents.delete(agent.id);
    for (const [runId, agentId] of session.runs) {
      if (!session.agents.has(agentId)) session.runs.delete(runId);
    }
  }
}

function snapshotOf(session: SessionEntry): SessionActivity {
  const agents = [...session.agents.values()];
  const running = agents.filter((a) => a.end === undefined).sort((a, b) => a.start - b.start);
  const ended = agents
    .filter((a) => a.end !== undefined)
    .sort((a, b) => (b.end ?? 0) - (a.end ?? 0));
  return {
    workspaceId: session.workspaceId,
    tabId: session.tabId,
    ...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
    ...(session.turnStart !== undefined ? { turnStart: session.turnStart } : {}),
    tools: session.tools.map((tool) => ({ ...tool })),
    toolCount: session.toolCount,
    failedCount: session.failedCount,
    files: [...session.files],
    todos: session.todos.map((todo) => ({ ...todo })),
    agents: [...running, ...ended].map(agentRunOf),
  };
}

function agentRunOf(agent: AgentEntry): AgentRun {
  const { asking: _asking, cwd: _cwd, watch: _watch, tools, ...run } = agent;
  return { ...run, tools: tools.map((tool) => ({ ...tool })) };
}

/**
 * What a tool works on, for a line about it: a command, a path relative to
 * the session's directory, a pattern, a URL, an agent's task.
 */
export function describeTool(
  name: string,
  input: Payload,
  cwd: string | undefined,
): { target?: string; note?: string } {
  const field = (key: string) => text(input[key]);
  const path = (key: string) => {
    const value = field(key);
    return value === undefined ? undefined : relative(value, cwd);
  };
  let target: string | undefined;
  let note: string | undefined;
  switch (name) {
    case "Bash":
    case "PowerShell":
      target = field("command");
      note = field("description");
      break;
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
      target = path("file_path");
      break;
    case "NotebookEdit":
      target = path("notebook_path");
      break;
    case "Grep": {
      const pattern = field("pattern");
      const where = path("path");
      target = pattern === undefined ? where : where ? `"${pattern}" · ${where}` : `"${pattern}"`;
      break;
    }
    case "Glob":
      target = field("pattern");
      break;
    case "WebFetch":
      target = field("url");
      break;
    case "WebSearch":
      target = field("query");
      break;
    case "Agent":
    case "Task":
      target = field("description");
      note = field("subagent_type");
      break;
    case "Skill":
      target = field("skill") ?? field("command");
      break;
    case "TaskCreate":
      target = field("subject");
      break;
    case "TaskUpdate": {
      const id = field("taskId");
      const status = field("status");
      target = id === undefined ? status : status ? `#${id} ${status}` : `#${id}`;
      break;
    }
    case "TodoWrite":
      break;
    default:
      target = firstText(input);
  }
  return { ...optional("target", target), ...optional("note", note) };
}

/** The todos a TodoWrite call sets, or undefined for an input not a list. */
function todosOf(value: unknown): Todo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item): Todo[] => {
    const todo = record(item);
    const content = text(todo.content);
    const status = todoStatus(todo.status);
    return content === undefined || status === undefined
      ? []
      : [{ content, ...optional("activeForm", text(todo.activeForm)), status }];
  });
}

/** The todo list after a TaskUpdate call. */
function updateTodo(todos: Todo[], input: Payload): Todo[] {
  const id = text(input.taskId);
  if (id === undefined) return todos;
  if (input.status === "deleted") return todos.filter((todo) => todo.id !== id);
  return todos.map((todo) => {
    if (todo.id !== id) return todo;
    const status = todoStatus(input.status) ?? todo.status;
    const content = text(input.subject) ?? todo.content;
    const activeForm = text(input.activeForm) ?? todo.activeForm;
    return { ...todo, content, status, ...optional("activeForm", activeForm) };
  });
}

function todoStatus(value: unknown): Todo["status"] | undefined {
  return value === "pending" || value === "in_progress" || value === "completed"
    ? value
    : undefined;
}

/**
 * Takes the oldest call for an agent of `type`, the one with `description`
 * when told; any call when none is for that type.
 */
function takeCall(calls: AgentCall[], type: string, description?: string): AgentCall | undefined {
  const index = [
    (c: AgentCall) =>
      c.type === type && (description === undefined || c.description === description),
    (c: AgentCall) => c.type === type,
    () => true,
  ]
    .map((matches) => calls.findIndex(matches))
    .find((i) => i !== -1);
  if (index === undefined) return undefined;
  return calls.splice(index, 1)[0];
}

/** A tool call as PermissionRequest and the tool hooks all describe it: its name and input. */
function callKey(p: Payload): string {
  return `${text(p.tool_name) ?? ""}\0${JSON.stringify(p.tool_input ?? null)}`;
}

/** `path` relative to `cwd` when under it. */
function relative(path: string, cwd: string | undefined): string {
  if (!cwd) return path;
  for (const sep of ["/", "\\"]) {
    const base = cwd.endsWith(sep) ? cwd : `${cwd}${sep}`;
    if (path.startsWith(base)) return path.slice(base.length);
  }
  return path;
}

/** The tool run started last. */
function latest(tools: readonly ToolRun[]): ToolRun | undefined {
  return tools.reduce<ToolRun | undefined>(
    (last, tool) => (last === undefined || tool.start >= last.start ? tool : last),
    undefined,
  );
}

/** The item of `items` latest by `when`. */
function latestBy<T>(items: readonly T[], when: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>(
    (last, item) => (last === undefined || when(item) >= when(last) ? item : last),
    undefined,
  );
}

function push(tools: ToolRun[], run: ToolRun, kept: number): void {
  tools.push(run);
  if (tools.length > kept) tools.splice(0, tools.length - kept);
}

function record(value: unknown): Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Payload)
    : {};
}

/** A non-empty string, trimmed and cut to ACTIVITY_TEXT_MAX_CHARS. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.length > ACTIVITY_TEXT_MAX_CHARS
    ? `${trimmed.slice(0, ACTIVITY_TEXT_MAX_CHARS)}…`
    : trimmed;
}

function firstLine(value: string | undefined): string | undefined {
  return value
    ?.split("\n")
    .find((line) => line.trim() !== "")
    ?.trim();
}

/** The first string field of a tool's input, as an MCP tool's. */
function firstText(input: Payload): string | undefined {
  for (const value of Object.values(input)) {
    const found = text(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string };
}
