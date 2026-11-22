import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type PeerCommit,
  readPeerCommit,
  readPeerCommitPatch,
} from "../../../../../src/renderer/components/peer-workspace/commit-model";
import {
  PeerCommitDetails,
  PeerCommitFilePatch,
} from "../../../../../src/renderer/components/peer-workspace/commit-tab";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";

const peer = { deviceId: "desk", workspaceId: "project" };
const detail: PeerCommit = {
  hash: "0123456789abcdef",
  parents: [],
  subject: "Add new file",
  body: "Commit description",
  author: "Ada",
  at: Date.UTC(2026, 2, 1, 15),
  files: [{ path: "src/new.ts", status: "A" }],
  truncated: true,
};

test("the commit message and truncated file list render independently of file patches", async () => {
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(ipcOk(detail));
  const { signal } = new AbortController();
  try {
    const result = await readPeerCommit(peer, detail.hash, signal);
    expect(result).toEqual(ipcOk(detail));
    expect(call).toHaveBeenCalledWith(
      "remote",
      "peerGitShow",
      { ...peer, hash: detail.hash },
      { signal },
    );
    const markup = renderToStaticMarkup(
      <PeerCommitDetails detail={detail} target={peer} canRead={false} rejoin={0} />,
    );
    expect(markup).toContain("Commit description");
    expect(markup).toContain("Ada");
    expect(markup).toContain('dateTime="2026-03-01T15:00:00.000Z"');
    expect(markup).toContain("Partial file list");
    expect(markup).toContain("src/new.ts");
  } finally {
    call.mockRestore();
  }
});

test("file errors and partial and binary patches stay in their own commit file sections", async () => {
  const outcomes = [
    ipcErr("not-found", "the server's private paths"),
    ipcErr("permission-denied", "the server's private paths"),
    ipcOk({ path: "c.ts", truncated: true, hunks: [] }),
    ipcOk({ path: "d.png", binary: true, hunks: [] }),
  ] as const;
  const call = spyOn(ipc, "ipcCallResult");
  for (const outcome of outcomes) call.mockResolvedValueOnce(outcome);
  const { signal } = new AbortController();
  try {
    const paths = ["a.ts", "b.ts", "c.ts", "d.png"];
    const [gone, forbidden, partial, binary] = await Promise.all(
      paths.map((path) => readPeerCommitPatch(peer, detail.hash, path, signal)),
    );
    for (const path of paths) {
      expect(call).toHaveBeenCalledWith(
        "remote",
        "peerGitDiff",
        { ...peer, commit: detail.hash, path },
        { signal },
      );
    }
    const markup = renderToStaticMarkup(
      <>
        <section id="gone">
          <PeerCommitFilePatch result={gone} canRead />
        </section>
        <section id="forbidden">
          <PeerCommitFilePatch result={forbidden} canRead />
        </section>
        <section id="partial">
          <PeerCommitFilePatch result={partial} canRead />
        </section>
        <section id="binary">
          <PeerCommitFilePatch result={binary} canRead />
        </section>
      </>,
    );
    expect(markup.match(/id="gone".*?<\/section>/s)?.[0]).toContain("Change no longer available");
    expect(markup.match(/id="forbidden".*?<\/section>/s)?.[0]).toContain("Permission denied");
    const partialSection = markup.match(/id="partial".*?<\/section>/s)?.[0];
    expect(partialSection).toContain("Full comparison unavailable · Changed sections only");
    expect(partialSection).toContain("Partial patch");
    expect(markup.match(/id="binary".*?<\/section>/s)?.[0]).toContain("Cannot display binary file");
    expect(markup).not.toContain("the server's private paths");
  } finally {
    call.mockRestore();
  }
});

test("closing a commit tab or switching peer ignores late detail and patch responses", async () => {
  const lateDetail = Promise.withResolvers<ReturnType<typeof ipcOk<PeerCommit>>>();
  const latePatch = Promise.withResolvers<ReturnType<typeof ipcErr>>();
  const call = spyOn(ipc, "ipcCallResult")
    .mockImplementationOnce(() => lateDetail.promise)
    .mockImplementationOnce(() => latePatch.promise);
  const controller = new AbortController();
  try {
    const reading = readPeerCommit(peer, detail.hash, controller.signal);
    const comparing = readPeerCommitPatch(peer, detail.hash, "src/new.ts", controller.signal);
    controller.abort();
    lateDetail.resolve(ipcOk(detail));
    latePatch.resolve(ipcErr("not-found", "file gone"));
    for (const attempt of [reading, comparing]) {
      expect(await attempt.catch((error) => error)).toBe(controller.signal.reason);
    }
  } finally {
    call.mockRestore();
  }
});
