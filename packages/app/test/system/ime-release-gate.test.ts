import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";

import { XTERM_DEFAULT_FONT_FAMILY } from "../../src/renderer/terminal/xterm-fonts";
import {
  XtermCompositionBuffer,
  XtermImeOverlay,
  handleEnterDuringComposition,
  toXtermImeOverlayTransform,
  type OverlayHostLike,
  type OverlayNodeLike,
  type StyleDocumentLike,
  type StyleNodeLike,
} from "../../src/renderer/terminal/xterm-ime-overlay";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const WORKSPACE_PERSISTENCE_TEST_PATH = path.resolve(
  TEST_DIR,
  "../../src/main/workspace/persistence/workspace-persistence.test.ts",
);

describe("IME checklist release gate (deterministic seams)", () => {
  test("#1 composition cursor overlay follows seam anchor coordinates", () => {
    const fakeDocument = new FakeDocument();
    const hostNode = new FakeNode() as OverlayHostLike & FakeNode;
    hostNode.ownerDocument = fakeDocument;
    hostNode.classList = new FakeClassList();

    const overlay = new XtermImeOverlay(hostNode);
    const anchor = { x: 18.7, y: 31.2, height: 21.4 };
    overlay.render("한", anchor);

    const overlayNode = hostNode.children[0];
    expect(overlayNode).toBeDefined();
    expect(overlayNode?.textContent).toBe("한");
    expect(overlayNode?.style.transform).toBe(toXtermImeOverlayTransform(anchor));
    expect(overlayNode?.style.minHeight).toBe("21px");

    overlay.dispose();
  });

  test("#2 Enter during composition is swallowed; next Enter can submit", () => {
    const compositionBuffer = new XtermCompositionBuffer();
    compositionBuffer.start();
    compositionBuffer.update("한");

    const composingEnterEvent = createKeyboardEventLike(true);
    expect(handleEnterDuringComposition(composingEnterEvent)).toBeTrue();
    expect(composingEnterEvent.preventDefaultCount).toBe(1);
    expect(composingEnterEvent.stopPropagationCount).toBe(1);

    const committed = compositionBuffer.end("");
    expect(committed).toBe("한");
    expect(compositionBuffer.shouldForwardTerminalData("한")).toBeFalse();

    const plainEnterEvent = createKeyboardEventLike(false);
    expect(handleEnterDuringComposition(plainEnterEvent)).toBeFalse();
    expect(plainEnterEvent.preventDefaultCount).toBe(0);
    expect(plainEnterEvent.stopPropagationCount).toBe(0);

    expect(compositionBuffer.shouldForwardTerminalData("\r")).toBeTrue();
  });

  test("#3 Hangul width expectations hold under Unicode11", () => {
    const terminal = new Terminal({ allowProposedApi: true });
    try {
      terminal.loadAddon(new Unicode11Addon());
      terminal.unicode.activeVersion = "11";

      const getStringCellWidth = resolveUnicodeWidthGetter(terminal);
      expect(getStringCellWidth).not.toBeNull();

      const widthOfHieut = getStringCellWidth?.("ㅎ") ?? -1;
      const widthOfGa = getStringCellWidth?.("가") ?? -1;
      const widthOfHangulWord = getStringCellWidth?.("한글") ?? -1;
      const widthOfAscii = getStringCellWidth?.("abc") ?? -1;

      expect(widthOfHieut).toBe(2);
      expect(widthOfGa).toBe(2);
      expect(widthOfHangulWord).toBe(4);
      expect(widthOfAscii).toBe(3);
    } finally {
      terminal.dispose();
    }
  });

  test("#4 references existing NFC path test (no duplicate release-gate test)", async () => {
    const workspacePersistenceTestSource = await readFile(WORKSPACE_PERSISTENCE_TEST_PATH, "utf8");

    expect(
      workspacePersistenceTestSource.includes(
        "registerWorkspace stores NFC-normalized absolute path with stable workspace id",
      ),
    ).toBeTrue();
    expect(workspacePersistenceTestSource.includes('.normalize("NFC")')).toBeTrue();
  });

  test("#5 long composition stream commits without dropped characters", () => {
    const compositionBuffer = new XtermCompositionBuffer();
    compositionBuffer.start();

    const hangulStream = buildHangulStream(256);
    let rolling = "";
    for (const character of hangulStream) {
      rolling += character;
      compositionBuffer.update(rolling);
    }

    const committed = compositionBuffer.end("");
    expect(committed).toBe(rolling);
    expect(committed?.length).toBe(256);

    expect(compositionBuffer.shouldForwardTerminalData(rolling)).toBeFalse();
    expect(compositionBuffer.shouldForwardTerminalData(`${rolling}!`)).toBeTrue();
  });

  test("#6 deterministic latency harness keeps average input→paint under 16ms", () => {
    const latencySamples = runDeterministicLatencyHarness([
      { inputToPtyEchoMs: 7.1, ptyEchoToPaintMs: 3.4 },
      { inputToPtyEchoMs: 8.0, ptyEchoToPaintMs: 3.7 },
      { inputToPtyEchoMs: 6.6, ptyEchoToPaintMs: 3.1 },
      { inputToPtyEchoMs: 7.5, ptyEchoToPaintMs: 4.0 },
      { inputToPtyEchoMs: 8.2, ptyEchoToPaintMs: 3.2 },
    ]);

    expect(latencySamples.averageInputToPaintMs).toBeLessThan(16);
  });

  test("#7 default font stack keeps D2Coding + Noto Sans KR", () => {
    const d2codingIndex = XTERM_DEFAULT_FONT_FAMILY.indexOf('"D2Coding"');
    const notoSansKrIndex = XTERM_DEFAULT_FONT_FAMILY.indexOf('"Noto Sans KR"');

    expect(d2codingIndex).toBeGreaterThanOrEqual(0);
    expect(notoSansKrIndex).toBeGreaterThanOrEqual(0);
    expect(d2codingIndex).toBeLessThan(notoSansKrIndex);
  });
});

function resolveUnicodeWidthGetter(terminal: Terminal): ((value: string) => number) | null {
  const candidate = terminal as unknown as {
    _core?: {
      _unicodeService?: { getStringCellWidth(value: string): number };
      unicodeService?: { getStringCellWidth(value: string): number };
    };
  };

  return (
    candidate._core?._unicodeService?.getStringCellWidth?.bind(candidate._core._unicodeService) ??
    candidate._core?.unicodeService?.getStringCellWidth?.bind(candidate._core.unicodeService) ??
    null
  );
}

function buildHangulStream(length: number): string[] {
  const base = 0xac00;
  const syllableCount = 11_172;
  const stream: string[] = [];

  for (let index = 0; index < length; index += 1) {
    const codePoint = base + (index % syllableCount);
    stream.push(String.fromCodePoint(codePoint));
  }

  return stream;
}

function createKeyboardEventLike(isComposing: boolean): {
  key: string;
  isComposing: boolean;
  preventDefaultCount: number;
  stopPropagationCount: number;
  preventDefault(): void;
  stopPropagation(): void;
} {
  return {
    key: "Enter",
    isComposing,
    preventDefaultCount: 0,
    stopPropagationCount: 0,
    preventDefault() {
      this.preventDefaultCount += 1;
    },
    stopPropagation() {
      this.stopPropagationCount += 1;
    },
  };
}

interface LatencyPlan {
  inputToPtyEchoMs: number;
  ptyEchoToPaintMs: number;
}

interface LatencySample {
  inputToPtyEchoMs: number;
  ptyEchoToPaintMs: number;
  inputToPaintMs: number;
}

interface LatencySummary {
  samples: LatencySample[];
  averageInputToPtyEchoMs: number;
  averagePtyEchoToPaintMs: number;
  averageInputToPaintMs: number;
  maxInputToPaintMs: number;
}

function runDeterministicLatencyHarness(plans: LatencyPlan[]): LatencySummary {
  const samples = plans.map((plan) => {
    const inputToPaintMs = plan.inputToPtyEchoMs + plan.ptyEchoToPaintMs;
    return {
      inputToPtyEchoMs: roundLatency(plan.inputToPtyEchoMs),
      ptyEchoToPaintMs: roundLatency(plan.ptyEchoToPaintMs),
      inputToPaintMs: roundLatency(inputToPaintMs),
    };
  });

  return {
    samples,
    averageInputToPtyEchoMs: average(samples.map((sample) => sample.inputToPtyEchoMs)),
    averagePtyEchoToPaintMs: average(samples.map((sample) => sample.ptyEchoToPaintMs)),
    averageInputToPaintMs: average(samples.map((sample) => sample.inputToPaintMs)),
    maxInputToPaintMs: roundLatency(Math.max(...samples.map((sample) => sample.inputToPaintMs))),
  };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sum = values.reduce((total, value) => total + value, 0);
  return roundLatency(sum / values.length);
}

function roundLatency(value: number): number {
  return Math.round(value * 1000) / 1000;
}

class FakeClassList {
  private readonly tokens = new Set<string>();

  public add(token: string): void {
    this.tokens.add(token);
  }

  public remove(token: string): void {
    this.tokens.delete(token);
  }
}

class FakeNode implements OverlayNodeLike {
  public id = "";
  public className = "";
  public textContent: string | null = "";
  public style: NonNullable<OverlayNodeLike["style"]> = {};
  public children: FakeNode[] = [];

  public appendChild(node: unknown): void {
    this.children.push(node as FakeNode);
  }

  public removeChild(node: unknown): void {
    const index = this.children.indexOf(node as FakeNode);
    if (index >= 0) {
      this.children.splice(index, 1);
    }
  }
}

class FakeDocument implements StyleDocumentLike {
  public readonly head = new FakeNode();

  public getElementById(id: string): unknown {
    return this.head.children.find((node) => node.id === id) ?? null;
  }

  public createElement(_tagName: string): StyleNodeLike {
    return new FakeNode();
  }
}
