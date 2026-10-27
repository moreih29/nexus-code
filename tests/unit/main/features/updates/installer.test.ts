/**
 * createUpdateInstaller — the steps of an in-place update over a fake backend
 * that plays electron-updater and Squirrel.Mac.
 */
import { describe, expect, it } from "bun:test";
import {
  createUpdateInstaller,
  type InstallStatus,
  type UpdateBackend,
} from "../../../../../src/main/features/updates/installer";

function setup(offered: string | null = "1.2.0") {
  const statuses: InstallStatus[] = [];
  let staged: () => void = () => {};
  let failed: (error: Error) => void = () => {};
  let finishDownload: () => void = () => {};
  let rejectDownload: (error: Error) => void = () => {};
  const calls = { check: 0, download: 0, quitAndInstall: 0 };

  const backend: UpdateBackend = {
    check: async () => {
      calls.check += 1;
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
    onError: (listener) => {
      failed = listener;
    },
    quitAndInstall: () => {
      calls.quitAndInstall += 1;
    },
  };
  const installer = createUpdateInstaller({
    backend,
    onStatus: (status) => statuses.push(status),
    releaseUrl: (version) => (version === null ? "releases" : `releases/v${version}`),
    logger: { info: () => {}, warn: () => {} },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    installer,
    statuses,
    calls,
    settle,
    stage: () => staged(),
    fail: (error: Error) => failed(error),
    finishDownload: () => finishDownload(),
    rejectDownload: (error: Error) => rejectDownload(error),
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
