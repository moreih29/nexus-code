/**
 * File drop — files dragged over a chat light it up until they are let go
 * there or the drag goes elsewhere, however it crosses the chat's children.
 */
import { describe, expect, it } from "bun:test";
import { carriesFiles, watchFileDrop } from "../../../../../src/renderer/services/chat/file-drop";

const BOX = { left: 0, top: 0, right: 100, bottom: 100 };

class Area extends EventTarget {
  contains(other: unknown): boolean {
    return other === this;
  }
  getBoundingClientRect() {
    return BOX;
  }
}

function drag(
  type: string,
  { types = ["Files"], files = [] as File[], at = [50, 50] as [number, number] } = {},
) {
  const dataTransfer = { types, files, dropEffect: "none" };
  const event = Object.assign(new Event(type, { cancelable: true }), {
    dataTransfer,
    clientX: at[0],
    clientY: at[1],
  });
  return event;
}

function setup() {
  const area = new Area();
  const doc = new EventTarget();
  const seen: boolean[] = [];
  const dropped: string[][] = [];
  const stop = watchFileDrop(
    area,
    {
      over: (over) => seen.push(over),
      drop: (files) => dropped.push(files.map((file) => file.name)),
    },
    doc,
  );
  return { area, doc, seen, dropped, stop };
}

describe("carriesFiles", () => {
  it("is a drag of files from outside the app", () => {
    expect(carriesFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(carriesFiles({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
    expect(carriesFiles(null)).toBe(false);
  });
});

describe("watchFileDrop", () => {
  it("is over from the first enter until the last leave, across children", () => {
    const { area, seen } = setup();
    const enter = drag("dragenter");
    area.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    area.dispatchEvent(drag("dragenter"));
    area.dispatchEvent(drag("dragleave"));
    expect(seen).toEqual([true]);
    area.dispatchEvent(drag("dragleave", { at: [150, 50] }));
    expect(seen).toEqual([true, false]);
  });

  it("leaves a drag of anything but files alone", () => {
    const { area, seen } = setup();
    const over = drag("dragover", { types: ["text/plain"] });
    area.dispatchEvent(over);
    area.dispatchEvent(drag("drop", { types: ["text/plain"] }));
    expect(over.defaultPrevented).toBe(false);
    expect(seen).toEqual([]);
  });

  it("takes a drag over it as a copy, even when it missed the enter", () => {
    const { area, seen } = setup();
    const over = drag("dragover");
    area.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("copy");
    area.dispatchEvent(drag("dragover"));
    expect(seen).toEqual([true]);
  });

  it("hands over what is let go on it, and is no longer over", () => {
    const { area, seen, dropped } = setup();
    area.dispatchEvent(drag("dragenter"));
    const file = new File(["x"], "a.png");
    const drop = drag("drop", { files: [file] });
    area.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(dropped).toEqual([["a.png"]]);
    expect(seen).toEqual([true, false]);
  });

  it("is gone once the drag leaves its box, though a child never said it was left", () => {
    const { area, seen } = setup();
    area.dispatchEvent(drag("dragenter"));
    area.dispatchEvent(drag("dragenter"));
    area.dispatchEvent(drag("dragenter"));
    area.dispatchEvent(drag("dragleave", { at: [100, 40] }));
    expect(seen).toEqual([true, false]);
    area.dispatchEvent(drag("dragleave", { at: [120, 40] }));
    expect(seen).toEqual([true, false]);
  });

  it("is gone once the drag is over another part of the app, let go, or called off", () => {
    const { area, doc, seen } = setup();
    for (const type of ["dragover", "drop", "dragend"]) {
      area.dispatchEvent(drag("dragenter"));
      doc.dispatchEvent(drag(type));
    }
    expect(seen).toEqual([true, false, true, false, true, false]);
  });

  it("is gone once the mouse moves again, should the drag have ended unheard", () => {
    const { area, doc, seen } = setup();
    area.dispatchEvent(drag("dragenter"));
    doc.dispatchEvent(new Event("mousemove"));
    doc.dispatchEvent(new Event("mousemove"));
    expect(seen).toEqual([true, false]);
  });

  it("stops following when told, and ends a drag that was over it", () => {
    const { area, seen, stop } = setup();
    area.dispatchEvent(drag("dragenter"));
    stop();
    area.dispatchEvent(drag("dragenter"));
    expect(seen).toEqual([true, false]);
  });
});
