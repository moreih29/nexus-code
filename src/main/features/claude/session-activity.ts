import {
  ACTIVITY_TEXT_MAX_CHARS,
  AGENT_MESSAGES_KEPT,
  AGENT_TOOLS_KEPT,
  type AgentRun,
  type AgentRunState,
  ENDED_AGENTS_KEPT,
  SESSION_TOOLS_KEPT,
  type SessionActivity,
  type Todo,
  type ToolRun,
} from "../../../shared/claude/activity";
import { shownPath } from "../../../shared/fs/relative-path";

const AGENT_TOOLS = new Set(["Agent", "Task"]);
const STOP_TASK_TOOLS = new Set(["TaskStop", "KillShell", "KillBash"]);
const AGENT_CALLS_KEPT = 16;
const TASK_LINKS_KEPT = 128;
const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);
const WRITING_TOOLS: Readonly<Record<string, string>> = {
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

interface AgentCall {
  readonly type: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly background?: boolean;
  readonly model?: string;
  readonly launchToolUseId?: string;
  readonly outputFile?: string;
}

type TaskEnd = "completed" | "failed" | "stopped";

interface TaskLink {
  toolUseId?: string;
  outputFile?: string;
  runId?: string;
  state?: TaskEnd;
}

interface AgentEntry extends Omit<AgentRun, "tools"> {
  tools: ToolRun[];
  asking?: string;
  cwd?: string;
  home?: string;
  watch?: string;
  said?: Set<string>;
  launchToolUseId?: string;
  outputFile?: string;
}

export interface SaidMessage {
  id: string;
  text: string;
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
  calls: AgentCall[];
  callsByAgent: Map<string, AgentCall>;
  taskLinks: Map<string, TaskLink>;
  runs: Map<string, string>;
}

export interface PrintRunSource {
  program: "claude" | "codex";
  running: boolean;
  sessionId?: string;
  home?: string;
  cwd?: string;
}

export type AgentListener = (workspaceId: string, tabId: string, agent: AgentRun) => void;

type Payload = Record<string, unknown>;

export class SessionActivityLog {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly listeners = new Set<AgentListener>();

  constructor(private readonly now: () => number = Date.now) {}

  noteHook(
    workspaceId: string,
    tabId: string,
    subcommand: string,
    payload: unknown,
    agentMessages?: readonly SaidMessage[],
  ): void {
    const p: Payload = typeof payload === "object" && payload !== null ? (payload as Payload) : {};
    const key = `${workspaceId}:${tabId}`;
    if (subcommand === "session-end") {
      this.drop(key);
      return;
    }
    if (subcommand === "session-start") {
      if (p.source !== "compact") this.drop(key);
    }
    const session = this.sessionOf(workspaceId, tabId);
    if (typeof p.cwd === "string" && p.cwd !== "") session.cwd = p.cwd;
    if (typeof p.session_id === "string" && p.session_id !== "") session.sessionId = p.session_id;
    const agentId = typeof p.agent_id === "string" && p.agent_id !== "" ? p.agent_id : undefined;
    if (agentId && agentMessages && agentMessages.length > 0) {
      this.saidBy(this.agentOf(session, agentId, p), agentMessages);
    }

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
          this.finishAgent(session, agent, "completed");
          this.pruneAgents(session);
        }
        break;
    }
  }

  noteTask(workspaceId: string, tabId: string, message: Payload): void {
    const taskId = text(message.task_id);
    const type = text(message.task_type);
    const state = taskEndOf(message.status);
    if (
      !taskId ||
      (type && type !== "local_agent") ||
      (message.subtype !== "task_started" && !state)
    )
      return;
    const existing = this.sessions.get(`${workspaceId}:${tabId}`);
    if (!existing && type !== "local_agent") return;
    const session = existing ?? this.sessionOf(workspaceId, tabId);
    const sessionId = text(message.session_id);
    if (sessionId && session.sessionId && sessionId !== session.sessionId) return;
    session.sessionId ??= sessionId;
    const runId = text(message.run_id);
    const previous = session.taskLinks.get(taskId);
    const differentRun = runId && previous?.runId && runId !== previous.runId;
    if (differentRun && message.subtype !== "task_started") return;
    const link = differentRun ? undefined : previous;
    this.rememberTask(session, taskId, {
      toolUseId: text(message.tool_use_id) ?? link?.toolUseId,
      outputFile: text(message.output_file) ?? link?.outputFile,
      runId: runId ?? link?.runId,
      state: state ?? link?.state,
    });
  }

  private rememberTask(session: SessionEntry, taskId: string, link: TaskLink): void {
    session.taskLinks.delete(taskId);
    session.taskLinks.set(taskId, link);
    if (session.taskLinks.size > TASK_LINKS_KEPT) {
      const oldest = session.taskLinks.keys().next().value;
      if (oldest !== undefined) session.taskLinks.delete(oldest);
    }
    if (!link.state) return;
    const agent = [...session.agents.values()].find((agent) => matchesTask(agent, taskId, link));
    if (agent) {
      this.finishAgent(session, agent, link.state);
      this.pruneAgents(session);
    }
  }

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
        run.prompt = text(p.prompt) ?? run.prompt;
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
        const took = p.duration_ms;
        if (typeof took === "number" && took > 0) {
          tool.start = Math.max(Math.min(tool.start, tool.end - took), toldBefore(run, tool));
        }
        if (p.is_error === true) {
          tool.failed = true;
          const error = firstLine(text(p.error));
          if (error !== undefined) tool.error = error;
          run.failedCount++;
        }
        break;
      }
      case "print-text": {
        const said = text(p.text);
        if (said === undefined) break;
        run.messages ??= [];
        run.messages.push({ at: this.now(), text: said });
        if (run.messages.length > AGENT_MESSAGES_KEPT) {
          run.messages.splice(0, run.messages.length - AGENT_MESSAGES_KEPT);
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

  notePrintWatch(workspaceId: string, tabId: string, runId: string, hookId: string): void {
    const session = this.sessions.get(`${workspaceId}:${tabId}`);
    const run = session && this.printRunOf(session, runId);
    if (run !== undefined && run.end === undefined) run.watch = hookId;
  }

  printWatch(workspaceId: string, tabId: string, agentId: string): string | undefined {
    const agent = this.sessions.get(`${workspaceId}:${tabId}`)?.agents.get(agentId);
    return agent?.kind === "print" && agent.end === undefined ? agent.watch : undefined;
  }

  printRunSource(workspaceId: string, tabId: string, runId: string): PrintRunSource | undefined {
    const agent = this.sessions.get(`${workspaceId}:${tabId}`)?.agents.get(runId);
    if (agent?.kind !== "print") return undefined;
    return {
      program: agent.program === "codex" ? "codex" : "claude",
      running: agent.end === undefined,
      ...optional("sessionId", agent.sessionId),
      ...optional("home", agent.home),
      ...optional("cwd", agent.cwd),
    };
  }

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

  noteTurnOver(workspaceId: string, tabId: string): void {
    const session = this.sessions.get(`${workspaceId}:${tabId}`);
    if (session) this.endOpenTools(session.tools);
  }

  get(workspaceId: string, tabId: string): SessionActivity | null {
    const session = this.sessions.get(`${workspaceId}:${tabId}`);
    return session ? snapshotOf(session) : null;
  }

  list(workspaceIds: readonly string[]): SessionActivity[] {
    const wanted = new Set(workspaceIds);
    return [...this.sessions.values()]
      .filter((session) => wanted.has(session.workspaceId))
      .map(snapshotOf);
  }

  clear(workspaceId: string, tabId: string): void {
    this.drop(`${workspaceId}:${tabId}`);
  }

  clearWorkspace(workspaceId: string): void {
    for (const [key, session] of this.sessions) {
      if (session.workspaceId === workspaceId) this.drop(key);
    }
  }

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
        taskLinks: new Map(),
        runs: new Map(),
      };
      this.sessions.set(key, session);
    }
    return session;
  }

  private saidBy(agent: AgentEntry, said: readonly SaidMessage[]): void {
    if (agent.end !== undefined) return;
    agent.said ??= new Set();
    for (const message of said) {
      const text = message.text.trim();
      if (agent.said.has(message.id) || text === "") continue;
      agent.said.add(message.id);
      agent.messages ??= [];
      agent.messages.push({ at: this.now(), text });
    }
    if (agent.messages && agent.messages.length > AGENT_MESSAGES_KEPT) {
      agent.messages.splice(0, agent.messages.length - AGENT_MESSAGES_KEPT);
    }
  }

  private agentOf(session: SessionEntry, agentId: string, p: Payload): AgentEntry {
    const known = session.agents.get(agentId);
    if (known) return known;
    const type = text(p.agent_type) ?? "general-purpose";
    const linkedCall = session.callsByAgent.get(agentId);
    const call = linkedCall ?? takeCall(session.calls, type);
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
      launchToolUseId: linkedCall?.launchToolUseId,
      outputFile: linkedCall?.outputFile,
    };
    session.agents.set(agentId, agent);
    this.emit(session, agent);
    this.finishKnownTask(session, agent);
    return agent;
  }

  private printStarted(session: SessionEntry, id: string, p: Payload): void {
    const command = latest(
      [session.tools, ...[...session.agents.values()].map((agent) => agent.tools)]
        .flat()
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
      ...optional("home", homeOf(p.home)),
    };
    session.agents.set(id, run);
    this.emit(session, run);
  }

  private printRunOf(session: SessionEntry, runId: string): AgentEntry | undefined {
    const run = session.agents.get(session.runs.get(runId) ?? runId);
    return run?.kind === "print" ? run : undefined;
  }

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

  private printResumed(session: SessionEntry, run: AgentEntry, runId: string, p: Payload): void {
    session.runs.set(runId, run.id);
    const prompt = text(p.prompt);
    if (prompt !== undefined) run.prompt = prompt;
    run.model = text(p.model) ?? run.model;
    run.endpoint = text(p.endpoint) ?? run.endpoint;
    run.cwd = text(p.cwd) ?? run.cwd;
    run.home = homeOf(p.home) ?? run.home;
    run.toolsTold = p.tools_told === true;
    run.start = this.now();
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
      if (agent.state === "permissionPending" && agent.asking !== callKey(p)) {
        agent.asking = undefined;
        this.setAgentState(session, agent, "running");
      }
    } else {
      push(session.tools, run, SESSION_TOOLS_KEPT);
      session.toolCount++;
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
    if (AGENT_TOOLS.has(name)) this.agentToolAnswered(session, input, response, id);
    if (STOP_TASK_TOOLS.has(name)) {
      const taskId = text(response.task_id) ?? text(input.task_id) ?? text(input.shell_id);
      const type = text(response.task_type);
      if (taskId && (!type || type === "local_agent")) {
        this.rememberTask(session, taskId, { ...session.taskLinks.get(taskId), state: "stopped" });
      }
    }
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

  private agentToolAnswered(
    session: SessionEntry,
    input: Payload,
    response: Payload,
    toolUseId: string | undefined,
  ): void {
    const agentId = text(response.agentId);
    if (agentId === undefined) return;
    const model = text(response.resolvedModel);
    const background = response.status === "async_launched";
    const outputFile = text(response.outputFile);
    const started = session.agents.get(agentId);
    if (started) {
      if (background) started.background = true;
      if (model !== undefined) started.model = model;
      if (toolUseId) started.launchToolUseId = toolUseId;
      if (outputFile) started.outputFile = outputFile;
      this.finishKnownTask(session, started);
      return;
    }
    const type = text(input.subagent_type) ?? "general-purpose";
    const call = takeCall(session.calls, type, text(input.description));
    if (call || background) {
      session.callsByAgent.set(agentId, {
        ...call,
        type,
        model: model ?? call?.model,
        background: background || call?.background,
        launchToolUseId: toolUseId,
        outputFile,
      });
      if (session.callsByAgent.size > AGENT_CALLS_KEPT) {
        const oldest = session.callsByAgent.keys().next().value;
        if (oldest !== undefined) session.callsByAgent.delete(oldest);
      }
    }
  }

  private finishKnownTask(session: SessionEntry, agent: AgentEntry): void {
    for (const [id, link] of session.taskLinks) {
      if (!link.state || !matchesTask(agent, id, link)) continue;
      this.finishAgent(session, agent, link.state);
      this.pruneAgents(session);
      return;
    }
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

  private endForegroundAgents(session: SessionEntry): void {
    for (const agent of session.agents.values()) {
      if (agent.end === undefined && !agent.background && agent.kind !== "print") {
        this.stopAgent(session, agent);
      }
    }
    this.pruneAgents(session);
  }

  private drop(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    for (const agent of session.agents.values()) {
      if (agent.end === undefined) this.stopAgent(session, agent);
    }
  }

  private stopAgent(session: SessionEntry, agent: AgentEntry): void {
    this.finishAgent(session, agent, "stopped");
  }

  private finishAgent(session: SessionEntry, agent: AgentEntry, state: TaskEnd): void {
    if (agent.end !== undefined) return;
    agent.end = this.now();
    agent.asking = undefined;
    agent.watch = undefined;
    this.endOpenTools(agent.tools);
    this.setAgentState(session, agent, state, true);
  }

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

function matchesTask(agent: AgentEntry, taskId: string, link: TaskLink): boolean {
  if (agent.kind !== "subagent") return false;
  if (agent.launchToolUseId && link.toolUseId) return agent.launchToolUseId === link.toolUseId;
  if (agent.outputFile && link.outputFile) return agent.outputFile === link.outputFile;
  return agent.background === true && agent.id === taskId;
}

function taskEndOf(status: unknown): TaskEnd | undefined {
  if (status === "completed" || status === "failed" || status === "stopped") return status;
  return status === "killed" ? "stopped" : undefined;
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
  const {
    asking: _asking,
    cwd: _cwd,
    home: _home,
    watch: _watch,
    said: _said,
    launchToolUseId: _launch,
    outputFile: _file,
    tools,
    messages,
    ...run
  } = agent;
  return {
    ...run,
    tools: tools.map((tool) => ({ ...tool })),
    ...(messages ? { messages: messages.map((message) => ({ ...message })) } : {}),
  };
}

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

function callKey(p: Payload): string {
  return `${text(p.tool_name) ?? ""}\0${JSON.stringify(p.tool_input ?? null)}`;
}

function relative(path: string, cwd: string | undefined): string {
  return cwd ? shownPath(path, cwd) : path;
}

function latest(tools: readonly ToolRun[]): ToolRun | undefined {
  return tools.reduce<ToolRun | undefined>(
    (last, tool) => (last === undefined || tool.start >= last.start ? tool : last),
    undefined,
  );
}

function latestBy<T>(items: readonly T[], when: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>(
    (last, item) => (last === undefined || when(item) >= when(last) ? item : last),
    undefined,
  );
}

function toldBefore(run: Pick<AgentEntry, "messages" | "tools">, tool: ToolRun): number {
  let at = 0;
  for (const message of run.messages ?? []) {
    if (message.at <= tool.start) at = Math.max(at, message.at);
  }
  for (const other of run.tools) {
    if (other === tool) break;
    at = Math.max(at, other.start);
  }
  return at;
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

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.length > ACTIVITY_TEXT_MAX_CHARS
    ? `${trimmed.slice(0, ACTIVITY_TEXT_MAX_CHARS)}…`
    : trimmed;
}

const HOME_MAX_CHARS = 4096;

function homeOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "" || value.length > HOME_MAX_CHARS) return undefined;
  return value;
}

function firstLine(value: string | undefined): string | undefined {
  return value
    ?.split("\n")
    .find((line) => line.trim() !== "")
    ?.trim();
}

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
