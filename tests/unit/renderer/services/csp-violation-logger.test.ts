import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  type CspViolation,
  describeViolation,
  installCspViolationLogger,
  isExpectedViolation,
  MAX_REPORTS,
} from "../../../../src/renderer/services/csp-violation-logger";

function violation(overrides: Partial<CspViolation> = {}): CspViolation {
  return {
    effectiveDirective: "script-src-elem",
    blockedURI: "https://cdn.example.com/x.js",
    disposition: "enforce",
    sourceFile: "file:///app/index.html",
    lineNumber: 3,
    ...overrides,
  };
}

/** A target that hands violations to the listener the logger adds. */
function fakeTarget() {
  let listener: ((event: Event) => void) | null = null;
  const target = {
    addEventListener: (_type: string, l: (event: Event) => void) => {
      listener = l;
    },
    removeEventListener: () => {
      listener = null;
    },
  } as unknown as EventTarget;
  const fire = (v: CspViolation) => listener?.(v as unknown as Event);
  return { target, fire, listening: () => listener !== null };
}

test("the renderer enables Zod jitless mode before loading the app", async () => {
  const entry = new URL("../../../../src/renderer/index.tsx", import.meta.url);
  const imports = new Bun.Transpiler({ loader: "tsx" }).scanImports(await Bun.file(entry).text());
  expect(imports[0]?.path).toBe("./zod-config");

  // Use a fresh process so the renderer's Zod config stays local to this test.
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `import "./src/renderer/zod-config";
       import { z } from "zod";
       if (z.config().jitless !== true) throw new Error("Expected Zod jitless mode");`,
    ],
    { cwd: fileURLToPath(new URL("../../../../", import.meta.url)), stderr: "pipe" },
  );
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

describe("describeViolation", () => {
  test("says what was blocked, by which directive, from where", () => {
    expect(describeViolation(violation())).toBe(
      "Content-Security-Policy blocked script-src-elem: https://cdn.example.com/x.js (file:///app/index.html:3)",
    );
    expect(describeViolation(violation({ disposition: "report", blockedURI: "" }))).toContain(
      "would block script-src-elem: inline code",
    );
  });

  test("shortens a long address", () => {
    const blockedURI = `data:image/png;base64,${"A".repeat(5000)}`;
    expect(describeViolation(violation({ blockedURI })).length).toBeLessThan(400);
  });
});

describe("installCspViolationLogger", () => {
  test("logs each directive and address once, up to the limit", () => {
    const { target, fire, listening } = fakeTarget();
    const lines: string[] = [];
    const remove = installCspViolationLogger(target, (line) => lines.push(line));
    fire(violation());
    fire(violation());
    fire(violation({ effectiveDirective: "img-src" }));
    expect(lines).toHaveLength(2);
    for (let i = 0; i < MAX_REPORTS + 10; i++) fire(violation({ blockedURI: `https://x/${i}` }));
    expect(lines).toHaveLength(MAX_REPORTS);
    remove();
    expect(listening()).toBe(false);
  });

  test("passes over Excalidraw's CDN fonts, which the app ships instead", () => {
    const { target, fire } = fakeTarget();
    const lines: string[] = [];
    installCspViolationLogger(target, (line) => lines.push(line));
    const cdn = "https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/Virgil/Virgil.woff2";
    for (let i = 0; i < MAX_REPORTS; i++) {
      fire(violation({ effectiveDirective: "font-src", blockedURI: `${cdn}?${i}` }));
    }
    expect(lines).toHaveLength(0);
    fire(
      violation({
        effectiveDirective: "font-src",
        blockedURI: "https://fonts.example.com/a.woff2",
      }),
    );
    fire(violation({ effectiveDirective: "connect-src", blockedURI: cdn }));
    expect(lines).toHaveLength(2);
  });
});

describe("isExpectedViolation", () => {
  test("takes only Excalidraw's font fallback", () => {
    const cdn = "https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/Xiaolai/x.woff2";
    expect(
      isExpectedViolation(violation({ effectiveDirective: "font-src", blockedURI: cdn })),
    ).toBe(true);
    expect(
      isExpectedViolation(violation({ effectiveDirective: "script-src-elem", blockedURI: cdn })),
    ).toBe(false);
    expect(
      isExpectedViolation(
        violation({ effectiveDirective: "font-src", blockedURI: "https://esm.sh/x" }),
      ),
    ).toBe(false);
  });
});
