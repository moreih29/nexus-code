import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu";

describe("ContextMenu", () => {
  test("does not mount closed menu content or Radix Popper anchors", () => {
    const closedMarkup = renderToStaticMarkup(
      <ContextMenu>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Open</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    const source = readFileSync(new URL("./context-menu.tsx", import.meta.url), "utf8");

    expect(closedMarkup).not.toContain('data-slot="context-menu-content"');
    expect(source).toContain("if (!context.open || typeof document === \"undefined\")");
    expect(source).toContain("createPortal");
    expect(source).not.toContain("ContextMenuPrimitive");
  });
});
