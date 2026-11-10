import { describe, expect, it } from "bun:test";
import { imageLookSize } from "../../../../../src/renderer/services/chat/image-look";

const AREA = { w: 1220, h: 620 };

describe("quick look's size around an image", () => {
  it("wraps a wide screenshot fitted to the area 64px in, under its header", () => {
    expect(imageLookSize(AREA, { w: 2560, h: 1600 }, 2)).toEqual({ w: 728, h: 492 });
  });

  it("makes a small image as large as a big one: the same height, so stepping keeps it", () => {
    expect(imageLookSize(AREA, { w: 256, h: 256 }, 2)).toEqual({ w: 456, h: 492 });
  });

  it("keeps room for the header beside a tall, narrow image", () => {
    expect(imageLookSize(AREA, { w: 600, h: 2000 }, 2)).toEqual({ w: 362, h: 492 });
  });

  it("is narrower than that only where the area is", () => {
    expect(imageLookSize({ w: 300, h: 260 }, { w: 2560, h: 1600 })).toEqual({ w: 172, h: 132 });
  });

  it("has none where the area has no room, or the image no size", () => {
    expect(imageLookSize({ w: 200, h: 150 }, { w: 100, h: 100 })).toBeNull();
    expect(imageLookSize(AREA, { w: 0, h: 0 })).toBeNull();
  });
});
