import { describe, expect, it } from "bun:test";
import path from "node:path";
import {
  createUpdateInstaller,
  type DownloadProgress,
  type InstallStatus,
  type UpdateBackend,
} from "../../../../../src/main/features/updates/installer";

function setup(
  initiallyOffered: string | null = "1.2.0",
  {
    installAsksForPassword = false,
    prepareRestart,
    quitAndInstall,
  }: {
    installAsksForPassword?: boolean;
    prepareRestart?: () => Promise<void>;
    quitAndInstall?: UpdateBackend["quitAndInstall"];
  } = {},
) {
  const statuses: InstallStatus[] = [];
  const warnings: string[] = [];
  const progress: { version: string; progress: DownloadProgress }[] = [];
  let staged: () => void = () => {};
  let advanced: (progress: DownloadProgress) => void = () => {};
  let failed: (error: Error) => void = () => {};
  let finishDownload: () => void = () => {};
  let rejectDownload: (error: Error) => void = () => {};
  const calls = { check: 0, download: 0, quitAndInstall: 0 };
  let offered: string | Error | null = initiallyOffered;

  const backend: UpdateBackend = {
    installAsksForPassword,
    ...(prepareRestart && { prepareRestart }),
    check: async () => {
      calls.check += 1;
      if (offered instanceof Error) throw offered;
      return offered;
    },
    download: () => {
      calls.download += 1;
      return new Promise((resolve, reject) => {
        finishDownload = resolve;
        rejectDownload = reject;
      });
    },
    onStaged: (listener) => {
      staged = listener;
    },
    onProgress: (listener) => {
      advanced = listener;
    },
    onError: (listener) => {
      failed = listener;
    },
    quitAndInstall: () => {
      calls.quitAndInstall += 1;
      return quitAndInstall?.();
    },
  };
  const installer = createUpdateInstaller({
    backend,
    onStatus: (status) => statuses.push(status),
    onProgress: (version, report) => progress.push({ version, progress: report }),
    releaseUrl: (version) => (version === null ? "releases" : `releases/v${version}`),
    logger: { info: () => {}, warn: (message: string) => void warnings.push(message) },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    installer,
    statuses,
    warnings,
    progress,
    calls,
    settle,
    stage: () => staged(),
    advance: (report: DownloadProgress) => advanced(report),
    fail: (error: Error) => failed(error),
    finishDownload: () => finishDownload(),
    rejectDownload: (error: Error) => rejectDownload(error),
    offer: (next: string | Error | null) => {
      offered = next;
    },
  };
}

describe("createUpdateInstaller", () => {
  it("downloads the offered version and restarts into it once Squirrel.Mac staged it", async () => {
    const t = setup();
    void t.installer.install("stable");
    await t.settle();
    expect(t.statuses).toEqual([{ kind: "downloading", version: "1.2.0" }]);

    t.installer.restart();
    expect(t.calls.quitAndInstall).toBe(0);

    t.finishDownload();
    t.stage();
    expect(t.statuses.at(-1)).toEqual({ kind: "ready", version: "1.2.0" });

    t.installer.restart();
    expect(t.calls.quitAndInstall).toBe(1);
  });

  it("waits for open windows to flush before handing off to the updater", async () => {
    const prepared = Promise.withResolvers<void>();
    const t = setup("1.2.0", { prepareRestart: () => prepared.promise });
    const install = t.installer.install("stable");
    await t.settle();
    t.finishDownload();
    t.stage();
    await install;

    const restarting = t.installer.restart();
    await t.installer.restart();
    expect(t.calls.quitAndInstall).toBe(0);
    prepared.resolve();
    await restarting;
    expect(t.calls.quitAndInstall).toBe(1);
  });

  it("reports a state flush failure during the asynchronous updater handoff", async () => {
    const t = setup("1.2.0", {
      quitAndInstall: async () => {
        throw new Error("Unable to save app state");
      },
    });
    const install = t.installer.install("stable");
    await t.settle();
    t.finishDownload();
    t.stage();
    await install;
    await t.installer.restart();
    expect(t.statuses.at(-1)).toEqual({ kind: "installFailed", releaseUrl: "releases/v1.2.0" });
  });

  it("names a state flush failure before the install by its code, without the paths", async () => {
    const folder = path.join("C:", "Users", "qa-user", "AppData", "Roaming", "NexusCode");
    const t = setup("1.2.0", {
      quitAndInstall: () => {
        throw Object.assign(
          new Error(
            `EPERM: operation not permitted, rename '${folder}state.json.vsctmp.sync' -> '${folder}state.json'`,
          ),
          { code: "EPERM", syscall: "rename" },
        );
      },
    });
    const install = t.installer.install("stable");
    await t.settle();
    t.finishDownload();
    t.stage();
    await install;
    await t.installer.restart();
    expect(t.statuses.at(-1)).toEqual({ kind: "installFailed", releaseUrl: "releases/v1.2.0" });
    expect(t.warnings).toEqual(["updates: in-place update to 1.2.0 failed: EPERM (rename)"]);
  });

  it("reports the download's progress, then the check Squirrel.Mac runs on it", async () => {
    const t = setup();
    const install = t.installer.install("stable");
    await t.settle();
    const report = { transferred: 40, total: 100, bytesPerSecond: 20 };
    t.advance(report);
    t.finishDownload();
    await install;
    t.advance({ transferred: 100, total: 100, bytesPerSecond: 20 });

    expect(t.progress).toEqual([{ version: "1.2.0", progress: report }]);
    expect(t.statuses).toEqual([
      { kind: "downloading", version: "1.2.0" },
      { kind: "verifying", version: "1.2.0" },
    ]);
    void t.installer.install("stable");
    expect(t.statuses.at(-1)).toEqual({ kind: "verifying", version: "1.2.0" });

    t.stage();
    expect(t.statuses.at(-1)).toEqual({ kind: "ready", version: "1.2.0" });
  });

  it("goes straight to ready when the update is staged before the download returns", async () => {
    const t = setup();
    const install = t.installer.install("stable");
    await t.settle();
    t.stage();
    t.finishDownload();
    await install;

    expect(t.statuses).toEqual([
      { kind: "downloading", version: "1.2.0" },
      { kind: "ready", version: "1.2.0" },
    ]);
  });

  it("reports a signature Squirrel.Mac rejects after the download and can start over", async () => {
    const t = setup();
    const install = t.installer.install("stable");
    await t.settle();
    t.finishDownload();
    await install;
    t.fail(new Error("Code signature did not pass validation"));

    expect(t.statuses.at(-1)).toEqual({ kind: "installFailed", releaseUrl: "releases/v1.2.0" });
    void t.installer.install("stable");
    await t.settle();
    expect(t.calls.check).toBe(2);
  });

  it("says a deb's install asks for the password, also when asked where it stands", async () => {
    const t = setup("1.2.0", { installAsksForPassword: true });
    const install = t.installer.install("stable");
    await t.settle();
    t.finishDownload();
    await install;
    t.stage();
    void t.installer.install("stable");

    const ready = { kind: "ready", version: "1.2.0", asksForPassword: true };
    expect(t.statuses.slice(-2)).toEqual([ready, ready]);
  });

  it("reports an install that fails on restart and can start over", async () => {
    const t = setup("1.2.0", { installAsksForPassword: true });
    const install = t.installer.install("stable");
    await t.settle();
    t.finishDownload();
    await install;
    t.stage();
    t.installer.restart();
    t.fail(new Error("Command pkexec exited with code 126"));

    expect(t.calls.quitAndInstall).toBe(1);
    expect(t.statuses.at(-1)).toEqual({ kind: "installFailed", releaseUrl: "releases/v1.2.0" });
    void t.installer.install("stable");
    await t.settle();
    expect(t.calls.check).toBe(2);
  });

  it("reports a failed download once, though the updater also emits it as an error", async () => {
    const t = setup();
    const install = t.installer.install("stable");
    await t.settle();
    const error = new Error("net::ERR_CONNECTION_RESET");
    t.fail(error);
    t.rejectDownload(error);
    await install;

    expect(t.statuses.filter((s) => s.kind === "installFailed")).toHaveLength(1);
  });

  it("points at every release when the feed offers no newer version", async () => {
    const t = setup(null);
    await t.installer.install("beta");

    expect(t.statuses).toEqual([{ kind: "installFailed", releaseUrl: "releases" }]);
    expect(t.calls.download).toBe(0);
  });

  it("reports where an update stands instead of starting a second one", async () => {
    const t = setup();
    void t.installer.install("stable");
    void t.installer.install("stable");
    await t.settle();
    void t.installer.install("stable");

    expect(t.calls.check).toBe(1);
    expect(t.calls.download).toBe(1);
    expect(t.statuses).toEqual([
      { kind: "downloading", version: "1.2.0" },
      { kind: "downloading", version: "1.2.0" },
    ]);
  });
});

describe("an update staged before a newer one came out", () => {
  async function staged(t: ReturnType<typeof setup>) {
    const install = t.installer.install("stable");
    await t.settle();
    t.finishDownload();
    t.stage();
    await install;
  }

  it("downloads the newer version in its place and restarts into that one", async () => {
    const t = setup("1.2.0");
    await staged(t);
    t.offer("1.3.0");

    void t.installer.install("stable");
    await t.settle();
    expect(t.statuses.slice(-2)).toEqual([
      { kind: "ready", version: "1.2.0" },
      { kind: "downloading", version: "1.3.0" },
    ]);
    t.finishDownload();
    t.stage();
    expect(t.statuses.at(-1)).toEqual({ kind: "ready", version: "1.3.0" });

    await t.installer.restart();
    expect(t.calls.download).toBe(2);
    expect(t.calls.quitAndInstall).toBe(1);
  });

  it("stays ready when the feed has nothing past the staged version", async () => {
    const t = setup("1.2.0");
    await staged(t);

    await t.installer.install("stable");
    expect(t.calls.check).toBe(2);
    expect(t.calls.download).toBe(1);
    expect(t.statuses.at(-1)).toEqual({ kind: "ready", version: "1.2.0" });
  });

  it("stays ready when the look fails, though the updater also emits the error", async () => {
    const t = setup("1.2.0");
    await staged(t);
    const error = new Error("net::ERR_INTERNET_DISCONNECTED");
    t.offer(error);

    const install = t.installer.install("stable");
    t.fail(error);
    await install;
    expect(t.statuses.at(-1)).toEqual({ kind: "ready", version: "1.2.0" });

    await t.installer.restart();
    expect(t.calls.quitAndInstall).toBe(1);
  });

  it("does not start a download once the restart has handed off", async () => {
    const t = setup("1.2.0");
    await staged(t);
    t.offer("1.3.0");

    const install = t.installer.install("stable");
    await t.installer.restart();
    await install;
    expect(t.calls.quitAndInstall).toBe(1);
    expect(t.calls.download).toBe(1);
  });
});
