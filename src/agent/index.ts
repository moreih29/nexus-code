console.log = console.error;
console.info = console.error;
console.warn = console.error;

const rootPath = rootPathFromArgv(process.argv);
if (!rootPath) {
  console.error("Usage: bun src/agent/index.ts <rootPath>");
  process.exit(2);
}

const {
  createAgentDispatcher,
  createProtocolErrorResponse,
  idFromMalformedLine,
  idFromParsedFrame,
  parseAgentRequest,
} = await import("./agent-dispatch");

const dispatch = createAgentDispatcher(rootPath);
const inFlight = new Set<Promise<void>>();
let terminating = false;

installSigtermHandler();
await writeFrame({ type: "ready" });
startNdjsonLoop();

/**
 * Writes one stdout NDJSON protocol frame.
 */
function writeFrame(obj: unknown): Promise<void> {
  const line = `${JSON.stringify(obj)}\n`;
  return new Promise((resolve, reject) => {
    process.stdout.write(line, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * Starts the stdin NDJSON loop without blocking independent requests.
 */
function startNdjsonLoop(): void {
  const lines = createLineSplitter((line) => {
    if (terminating) {
      return;
    }

    const pending = handleLine(line)
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        inFlight.delete(pending);
      });
    inFlight.add(pending);
  });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    lines.push(String(chunk));
  });
  process.stdin.on("end", () => {
    lines.flush();
    void drainAndExit(0);
  });
  process.stdin.resume();
}

/**
 * Parses and handles one complete NDJSON request line.
 */
async function handleLine(line: string): Promise<void> {
  if (line.length === 0) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    const id = idFromMalformedLine(line) ?? "agent-protocol-error";
    await writeFrame(createProtocolErrorResponse(id, "malformed JSON"));
    return;
  }

  try {
    const request = parseAgentRequest(parsed);
    await writeFrame(await dispatch(request));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const id = idFromParsedFrame(parsed) ?? "agent-protocol-error";
    await writeFrame(createProtocolErrorResponse(id, message));
  }
}

/**
 * Installs SIGTERM handling that gives current requests a short drain window.
 */
function installSigtermHandler(): void {
  process.once("SIGTERM", () => {
    void drainAndExit(0);
  });
}

/**
 * Stops accepting input and exits after in-flight frame writes settle.
 */
async function drainAndExit(code: number): Promise<void> {
  if (terminating) {
    return;
  }
  terminating = true;
  process.stdin.pause();

  const forceExit = setTimeout(() => {
    process.exit(code);
  }, 75);
  forceExit.unref?.();

  await Promise.allSettled(Array.from(inFlight));
  clearTimeout(forceExit);
  process.exit(code);
}

/**
 * Extracts rootPath from Bun/Node argv or a direct executable argv shape.
 */
function rootPathFromArgv(argv: readonly string[]): string | null {
  if (argv[2]) {
    return argv[2];
  }

  for (let i = 1; i < argv.length; i++) {
    const value = argv[i];
    if (isRuntimeArg(value) || isAgentScriptArg(value)) {
      continue;
    }
    return value;
  }

  return null;
}

/**
 * Identifies runtime executable names that are not the rootPath argument.
 */
function isRuntimeArg(value: string): boolean {
  const base = basename(value);
  return base === "node" || base === "node.exe" || base === "bun" || base === "bun.exe";
}

/**
 * Identifies the source entry script when argv[2] is not available.
 */
function isAgentScriptArg(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return normalized === "src/agent/index.ts" || normalized.endsWith("/src/agent/index.ts");
}

/**
 * Returns the final path component without importing before console redirection.
 */
function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/**
 * Builds a reusable line splitter for stdin chunks.
 */
function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = "";

  return {
    push(chunk) {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        onLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer.length === 0) {
        return;
      }
      const line = buffer.replace(/\r$/, "");
      buffer = "";
      onLine(line);
    },
  };
}

export {};
