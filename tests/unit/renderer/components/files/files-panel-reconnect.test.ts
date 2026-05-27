/**
 * Unit tests for the SSH reconnect action in FilesPanel.
 *
 * Tests cover:
 *   (a) reconnectWorkspace 성공 시 callActivate 호출되고 onError 미호출
 *   (b) reconnectWorkspace 실패(ok:false) 시 onError 호출
 *   (c) EmptyState에 actionLabel="Reconnect" 렌더 확인 (renderToStaticMarkup)
 *   (d) EmptyState에 disabled 상태일 때 "Reconnecting…" 라벨 렌더 확인
 *
 * 설계 선택:
 *   - reconnectWorkspace는 pure async 함수로 export되어 있어 IPC / React 없이 테스트 가능.
 *   - EmptyState 렌더 분기는 renderToStaticMarkup으로 정적 HTML 어설션.
 *   - bun:test + react-dom/server 패턴 (기존 view-mode-toggle.test.tsx 동일).
 */
import { describe, expect, it, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// Window IPC stub — 모듈 로드 시점에 window.ipc / window.addEventListener를
// 참조하는 transitive import가 존재하므로 import 전에 stub 설정.
// ---------------------------------------------------------------------------
(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { reconnectWorkspace } = await import(
  "../../../../../src/renderer/components/files/panel"
);
const { EmptyState } = await import(
  "../../../../../src/renderer/components/ui/empty-state"
);

// ---------------------------------------------------------------------------
// (a) 성공 시 callActivate가 호출되고 onError는 미호출
// ---------------------------------------------------------------------------

describe("reconnectWorkspace — 성공", () => {
  it("ok:true 응답이면 callActivate를 호출하고 onError는 호출하지 않는다", async () => {
    const callActivate = mock(() => Promise.resolve({ ok: true as const }));
    const onError = mock((_msg: string) => {});

    await reconnectWorkspace("ws-id-1", { callActivate, onError });

    expect(callActivate).toHaveBeenCalledWith("ws-id-1");
    expect(onError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (b) 실패 시 onError 호출
// ---------------------------------------------------------------------------

describe("reconnectWorkspace — 실패", () => {
  it("ok:false 응답이면 onError가 SSH 설정 안내 메시지로 호출된다", async () => {
    const callActivate = mock(() =>
      Promise.resolve({ ok: false as const, message: "activate failed" }),
    );
    const capturedMessages: string[] = [];
    const onError = mock((msg: string) => {
      capturedMessages.push(msg);
    });

    await reconnectWorkspace("ws-id-2", { callActivate, onError });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(capturedMessages[0]).toContain("Failed to reconnect");
    expect(capturedMessages[0]).toContain("SSH settings");
  });
});

// ---------------------------------------------------------------------------
// (c) EmptyState에 actionLabel="Reconnect" 렌더 확인
// ---------------------------------------------------------------------------

describe("EmptyState — Reconnect 버튼 렌더", () => {
  it("actionLabel='Reconnect'와 onAction이 주어지면 Reconnect 버튼 텍스트가 HTML에 포함된다", () => {
    const html = renderToStaticMarkup(
      EmptyState({
        title: "Not connected",
        description: "Connect to the workspace to browse files.",
        tone: "status",
        actionLabel: "Reconnect",
        onAction: () => {},
        disabled: false,
      }),
    );

    expect(html).toContain("Reconnect");
    // 버튼 요소로 렌더되어야 한다
    expect(html).toContain("<button");
  });
});

// ---------------------------------------------------------------------------
// (d) disabled=true 상태에서 "Reconnecting…" 라벨 렌더 확인
// ---------------------------------------------------------------------------

describe("EmptyState — Reconnecting 상태", () => {
  it("actionLabel='Reconnecting…'와 disabled=true이면 button에 disabled 어트리뷰트가 설정된다", () => {
    const html = renderToStaticMarkup(
      EmptyState({
        title: "Not connected",
        description: "Connect to the workspace to browse files.",
        tone: "status",
        actionLabel: "Reconnecting…",
        onAction: () => {},
        disabled: true,
      }),
    );

    expect(html).toContain("Reconnecting");
    // React는 disabled=true를 disabled="" 로 직렬화한다.
    // " disabled" (공백 포함) 패턴으로 HTML 어트리뷰트 존재를 확인.
    expect(html).toMatch(/ disabled[=">]/);
  });

  it("disabled=false이면 Reconnect 버튼에 disabled HTML 어트리뷰트가 없다", () => {
    const html = renderToStaticMarkup(
      EmptyState({
        title: "Not connected",
        description: "Connect to the workspace to browse files.",
        tone: "status",
        actionLabel: "Reconnect",
        onAction: () => {},
        disabled: false,
      }),
    );

    expect(html).toContain("Reconnect");
    // React는 disabled=false를 HTML 어트리뷰트로 출력하지 않으므로
    // " disabled" (공백 포함) 패턴이 없어야 한다.
    // class 문자열 안의 "disabled:" Tailwind 변형자와 구별하기 위해 " disabled" 검사.
    expect(html).not.toMatch(/ disabled[=">]/);
  });
});
