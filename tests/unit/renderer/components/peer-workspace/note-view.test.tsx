import { expect, test } from "bun:test";
import { act } from "react";
import { PeerNoteView } from "../../../../../src/renderer/components/peer-workspace/note-tab";
import type { PeerNote } from "../../../../../src/renderer/components/peer-workspace/notes-model";
import { cliTranscriptMarkdown } from "../../../../../src/shared/notes/transcript";
import { withTestDom } from "../../../../helpers/test-dom";

const startedAt = new Date(2026, 10, 19, 12, 30).getTime();

const lines = [
  { s: "1", name: "Jimin", at: 0, text: "Let's start with the schedule." },
  { s: "2", name: null, at: 45_000, text: "The second phase moves to March." },
  { s: "1", name: "Jimin", at: 54_000, text: "Then we widen the scope." },
].map(({ s, name, at, text }, i) => ({
  id: `${at}:${at + 5000}:${i + 1}`,
  speaker: s,
  speakerLabel: `Speaker ${s}`,
  speakerName: name,
  startMs: at,
  endMs: at + 5000,
  text,
}));

const recording = {
  id: "rabcdef1234",
  startedAt,
  ms: 1_771_000,
  participants: "auto" as const,
  lines,
};

const transcript = cliTranscriptMarkdown("Scope talk", [recording]);

const structured: PeerNote = {
  id: "nabcdef1",
  title: "Scope talk",
  updatedAt: startedAt,
  markdown: "# Scope talk\n\nAgenda for the call.\n",
  transcript,
  transcriptRecordings: [recording],
};

const withTasks: PeerNote = {
  ...structured,
  markdown: "# Scope talk\n\n- [x] Share the schedule\n- [ ] Draft the test plan\n",
};

const markdownOnly: PeerNote = { ...structured, transcriptRecordings: undefined };

async function shown(note: PeerNote, check: (host: HTMLElement) => Promise<void> | void) {
  await withTestDom(async (host, root) => {
    for (const side of ["offsetHeight", "offsetWidth"]) {
      Object.defineProperty(Object.getPrototypeOf(host), side, {
        configurable: true,
        get: () => 800,
      });
    }
    await act(async () => {
      root.render(<PeerNoteView note={note} workspaceId="project" workspaceName="project" />);
    });
    await check(host);
  });
}

function texts(host: HTMLElement, selector: string): string[] {
  return Array.from(host.querySelectorAll(selector), (el) => el.textContent ?? "");
}

for (const [what, note] of [
  ["its speakers and lines", structured],
  ["only Markdown, from an older computer", markdownOnly],
] as const) {
  test(`a note with ${what} shows the transcript in the local panel, one row a line`, async () => {
    await shown(note, (host) => {
      const panel = host.querySelector('[data-testid="note-transcript"]');
      expect(panel?.tagName).toBe("ASIDE");
      expect(host.querySelectorAll('[data-testid="transcript-recording"]')).toHaveLength(1);
      expect(texts(host, '[data-testid="transcript-line-speaker"]')).toEqual([
        "Jimin",
        "Speaker 2",
        "Jimin",
      ]);
      expect(texts(host, '[data-testid="transcript-line"]')[1]).toBe(
        "0:45Speaker 2The second phase moves to March.",
      );
      expect(texts(host, '[data-testid="speaker-chip"]')).toEqual(["Jimin", "Speaker 2"]);
      expect(host.querySelector('[data-testid="transcript-recording"]')?.textContent).toContain(
        "29:31",
      );

      const body = host.querySelector('[data-testid="peer-note-body"]');
      expect(body?.textContent).toContain("Agenda for the call.");
      expect(body?.textContent).not.toContain("Jimin");
      expect(body?.textContent).not.toContain("Recording");
      expect(host.textContent).not.toContain("[0:45]");
    });
  });
}

test("nothing in the transcript changes the note on the other computer", async () => {
  await shown(structured, (host) => {
    const panel = host.querySelector('[data-testid="note-transcript"]') as HTMLElement;
    expect(panel.querySelector('button[data-testid="transcript-line-speaker"]') ?? null).toBeNull();
    expect(panel.querySelectorAll('[data-testid="transcript-line"] [aria-haspopup]')).toHaveLength(
      0,
    );
    for (const label of ["Quote in the note", "Change speaker", "More", "Name this person"]) {
      expect(panel.querySelector(`[aria-label="${label}"], [title="${label}"]`) ?? null).toBeNull();
    }
    expect(panel.querySelector('[data-testid="speaker-chip-rename"]') ?? null).toBeNull();
    expect(panel.querySelector('[data-testid="recording-aftercare"]') ?? null).toBeNull();
    expect(panel.querySelector('[data-testid="speaker-count-prompt"]') ?? null).toBeNull();
    expect(host.querySelector('[data-testid="note-to-agent"]') ?? null).toBeNull();
    expect(host.querySelector("input, textarea, [contenteditable]") ?? null).toBeNull();
    expect(host.textContent).toContain("Read-only");
  });
});

test("the transcript hides and comes back as on this computer", async () => {
  await shown(structured, async (host) => {
    const hide = host.querySelector('[aria-label="Hide the transcript"]') as HTMLElement;
    await act(async () => hide.click());
    expect(host.querySelector('[data-testid="note-transcript"]') ?? null).toBeNull();
    const show = host.querySelector('[data-testid="note-show-transcript"]') as HTMLElement;
    expect(show.textContent).toBe("Transcript");
    await act(async () => show.click());
    expect(host.querySelector('[data-testid="note-transcript"]')).not.toBeNull();
  });
});

test("a note without recordings has no transcript panel and no button for one", async () => {
  await shown(
    { ...structured, transcript: "", transcriptRecordings: [], recordings: [] },
    (host) => {
      expect(host.querySelector('[data-testid="note-transcript"]') ?? null).toBeNull();
      expect(host.querySelector('[data-testid="note-show-transcript"]') ?? null).toBeNull();
      expect(host.querySelector('[data-testid="peer-note-body"]')?.textContent).toContain(
        "Agenda for the call.",
      );
    },
  );
});

test("a note's checklist shows as on this computer but nothing ticks it", async () => {
  await shown(withTasks, async (host) => {
    const boxes = Array.from(
      host.querySelectorAll<HTMLInputElement>(
        '[data-testid="peer-note-body"] input[type="checkbox"]',
      ),
    );
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    expect(
      Array.from(
        host.querySelectorAll('[data-testid="peer-note-body"] li'),
        (li) => li.lastChild?.textContent,
      ),
    ).toEqual(["Share the schedule", "Draft the test plan"]);
    for (const box of boxes) {
      expect(box.getAttribute("aria-disabled")).toBe("true");
      expect(box.parentElement?.className).toBe("note-read-check");
      const before = box.checked;
      await act(async () => box.click());
      expect(box.checked).toBe(before);
    }
  });
});

test("a recording's heading row keeps the height of the local one, which holds its menu button", async () => {
  await shown(structured, (host) => {
    const row = host.querySelector('[data-testid="transcript-recording"] > div');
    expect(row?.className.split(" ")).toContain("min-h-8");
  });
});
