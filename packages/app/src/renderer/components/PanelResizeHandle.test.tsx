import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";

import { PanelResizeHandle } from "./PanelResizeHandle";

describe("PanelResizeHandle", () => {
  test("renders a vertical separator with column resize hit area classes and ARIA", () => {
    const handle = renderHandle({
      orientation: "vertical",
      dragging: false,
      "aria-label": "Resize workspace panel",
      "aria-valuemin": 280,
      "aria-valuemax": 520,
      "aria-valuenow": 320,
    });

    expect(handle.props.role).toBe("separator");
    expect(handle.props.tabIndex).toBe(0);
    expect(handle.props["aria-orientation"]).toBe("vertical");
    expect(handle.props["aria-label"]).toBe("Resize workspace panel");
    expect(handle.props["aria-valuemin"]).toBe(280);
    expect(handle.props["aria-valuemax"]).toBe(520);
    expect(handle.props["aria-valuenow"]).toBe(320);
    expect(handle.props["data-resize-handle-state"]).toBe("inactive");

    expectClassNames(handle, [
      "w-px",
      "cursor-col-resize",
      "before:-left-1",
      "before:w-2",
      "bg-border",
      "hover:bg-primary",
      "transition-colors",
      "duration-100",
      "hover:delay-100",
      "focus-visible:ring-2",
      "focus-visible:ring-ring",
      "focus-visible:ring-offset-1",
    ]);
  });

  test("renders a horizontal separator with row resize hit area classes and drag state styling", () => {
    const handle = renderHandle({
      orientation: "horizontal",
      dragging: true,
      "aria-label": "Resize terminal panel",
      "aria-valuemin": 128,
      "aria-valuemax": 512,
      "aria-valuenow": 256,
    });

    expect(handle.props.role).toBe("separator");
    expect(handle.props["aria-orientation"]).toBe("horizontal");
    expect(handle.props["aria-label"]).toBe("Resize terminal panel");
    expect(handle.props["aria-valuemin"]).toBe(128);
    expect(handle.props["aria-valuemax"]).toBe(512);
    expect(handle.props["aria-valuenow"]).toBe(256);
    expect(handle.props["data-resize-handle-state"]).toBe("drag");

    expectClassNames(handle, [
      "h-px",
      "cursor-row-resize",
      "before:-top-1",
      "before:h-2",
      "data-[resize-handle-state=drag]:bg-primary",
      "data-[resize-handle-state=drag]:delay-0",
      "data-[resize-handle-state=drag]:transition-none",
    ]);
  });
});

function renderHandle(
  props: Omit<Parameters<typeof PanelResizeHandle>[0], "onPointerDown" | "onKeyDown">,
): ReactElement {
  return PanelResizeHandle({
    ...props,
    onKeyDown() {},
    onPointerDown() {},
  }) as ReactElement;
}

function expectClassNames(element: ReactElement, classNames: string[]): void {
  const actualClassName = String(element.props.className);

  for (const className of classNames) {
    expect(actualClassName).toContain(className);
  }
}
