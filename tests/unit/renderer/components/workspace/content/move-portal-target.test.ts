import { describe, expect, it } from "bun:test";
import { movePortalTarget } from "../../../../../../src/renderer/components/workspace/content/move-portal-target";

/** A media element that records what its controls were set to. */
function fakeMedia(log: string[], name: string) {
  return {
    set controls(on: boolean) {
      log.push(`${name}.controls=${on}`);
    },
  };
}

function fakeNode(log: string[], media: unknown[], connected = true) {
  return {
    isConnected: connected,
    querySelectorAll(selector: string) {
      log.push(`query ${selector}`);
      return media;
    },
  } as unknown as HTMLElement;
}

function fakeParent(log: string[], options: { moveBefore?: boolean; throws?: boolean } = {}) {
  const parent: Record<string, unknown> = {
    isConnected: true,
    appendChild() {
      log.push("appendChild");
    },
  };
  if (options.moveBefore !== false) {
    parent.moveBefore = () => {
      log.push("moveBefore");
      if (options.throws) throw new Error("HierarchyRequestError");
    };
  }
  return parent as unknown as HTMLElement;
}

describe("movePortalTarget", () => {
  it("redraws the media controls after moveBefore", () => {
    const log: string[] = [];
    const media = [fakeMedia(log, "audio"), fakeMedia(log, "video")];
    movePortalTarget(fakeParent(log), fakeNode(log, media));
    expect(log).toEqual([
      "moveBefore",
      "query audio[controls], video[controls]",
      "audio.controls=false",
      "audio.controls=true",
      "video.controls=false",
      "video.controls=true",
    ]);
  });

  it("leaves the media alone when it appends: an insert draws the controls", () => {
    const log: string[] = [];
    const media = [fakeMedia(log, "audio")];
    movePortalTarget(fakeParent(log), fakeNode(log, media, false));
    expect(log).toEqual(["appendChild"]);
  });

  it("appends where there is no moveBefore", () => {
    const log: string[] = [];
    movePortalTarget(fakeParent(log, { moveBefore: false }), fakeNode(log, []));
    expect(log).toEqual(["appendChild"]);
  });

  it("appends when moveBefore refuses the move", () => {
    const log: string[] = [];
    const media = [fakeMedia(log, "audio")];
    movePortalTarget(fakeParent(log, { throws: true }), fakeNode(log, media));
    expect(log).toEqual(["moveBefore", "appendChild"]);
  });
});
