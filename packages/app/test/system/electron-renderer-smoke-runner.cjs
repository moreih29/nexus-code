const { app, BrowserWindow } = require("electron");

const targetUrl = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? "15000");
const resultGlobalName = process.argv[4] ?? "__nexusFileTreeFolderToggleSmokeResult";
const suspiciousMessagePattern =
  /Maximum update depth exceeded|An error occurred in the <(?:Presence|PopperAnchor|FileIcon)> component|<Presence>|<PopperAnchor>|<FileIcon>|getSnapshot should be cached|Could not create web worker|MonacoEnvironment\.getWorker|MonacoEnvironment\.getWorkerUrl|worker_file|ts\.worker|json\.worker|Falling back to loading web worker code in main thread|Uncaught \[object Event\]|Uncaught Event/i;

if (!targetUrl) {
  console.error("Usage: electron-renderer-smoke-runner.cjs <url> [timeoutMs]");
  process.exit(2);
}

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");

const logs = [];
let finished = false;

function recordLog(level, message, lineNumber = 0, sourceId = "") {
  logs.push({
    level,
    message: String(message),
    lineNumber,
    sourceId,
  });
}

function finish(exitCode, payload) {
  if (finished) {
    return;
  }
  finished = true;
  const result = {
    ...payload,
    logs,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  app.exit(exitCode);
}

function suspiciousMessagesFromLogs() {
  return logs
    .map((entry) => entry.message)
    .filter((message) => suspiciousMessagePattern.test(message));
}

async function waitForRendererResult(window) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await window.webContents.executeJavaScript(
      `globalThis[${JSON.stringify(resultGlobalName)}] ?? null`,
      true,
    );
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1000,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.webContents.on("console-message", (_event, level, message, lineNumber, sourceId) => {
    recordLog(level, message, lineNumber, sourceId);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    finish(1, {
      status: "render-process-gone",
      details,
      suspiciousMessages: suspiciousMessagesFromLogs(),
    });
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    finish(1, {
      status: "did-fail-load",
      errorCode,
      errorDescription,
      validatedUrl,
      suspiciousMessages: suspiciousMessagesFromLogs(),
    });
  });

  try {
    await window.loadURL(targetUrl);
    const rendererResult = await waitForRendererResult(window);
    const suspiciousMessages = suspiciousMessagesFromLogs();
    if (!rendererResult) {
      finish(1, {
        status: "timeout",
        timeoutMs,
        suspiciousMessages,
      });
      return;
    }
    if (suspiciousMessages.length > 0 || rendererResult.ok !== true) {
      finish(1, {
        status: "renderer-failed",
        rendererResult,
        suspiciousMessages,
      });
      return;
    }
    finish(0, {
      status: "ok",
      rendererResult,
      suspiciousMessages,
    });
  } catch (error) {
    finish(1, {
      status: "runner-error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
      suspiciousMessages: suspiciousMessagesFromLogs(),
    });
  }
}).catch((error) => {
  finish(1, {
    status: "app-ready-error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
    suspiciousMessages: suspiciousMessagesFromLogs(),
  });
});
