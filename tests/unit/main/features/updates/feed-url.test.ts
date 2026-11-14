/** The update feed NEXUS_UPDATE_FEED_URL may point the updater at. */
import { describe, expect, test } from "bun:test";
import { updateFeedUrl } from "../../../../../src/main/features/updates/feed-url";

describe("the update feed the environment names", () => {
  test("is taken over https, or over http on this machine", () => {
    expect(updateFeedUrl("https://example.com/feed/")).toBe("https://example.com/feed/");
    expect(updateFeedUrl("http://localhost:8000/")).toBe("http://localhost:8000/");
    expect(updateFeedUrl("http://127.0.0.1:8000/x")).toBe("http://127.0.0.1:8000/x");
    expect(updateFeedUrl("http://[::1]:8000/")).toBe("http://[::1]:8000/");
  });

  test("is not taken over plain http elsewhere, nor another scheme, nor what is not a URL", () => {
    const warned: string[] = [];
    const warn = (message: string) => warned.push(message);
    expect(updateFeedUrl("http://example.com/feed/", warn)).toBeNull();
    expect(updateFeedUrl("http://localhost.example.com/", warn)).toBeNull();
    expect(updateFeedUrl("file:///tmp/feed/", warn)).toBeNull();
    expect(updateFeedUrl("not a url", warn)).toBeNull();
    expect(warned).toHaveLength(4);
  });

  test("none set is none, unwarned", () => {
    const warned: string[] = [];
    expect(updateFeedUrl(undefined, (m) => warned.push(m))).toBeNull();
    expect(updateFeedUrl("  ", (m) => warned.push(m))).toBeNull();
    expect(warned).toEqual([]);
  });
});
