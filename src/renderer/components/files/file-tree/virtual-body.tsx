import type { Virtualizer } from "@tanstack/react-virtual";
import type { ReactNode } from "react";
import { ROW_HEIGHT_PX } from "./metrics";

export function FileTreeVirtualBody({
  virtualizer,
  renderRow,
  rowKey,
}: {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  renderRow: (index: number) => ReactNode;
  rowKey?: (index: number) => string | undefined;
}) {
  return (
    <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
      {virtualizer.getVirtualItems().map(({ key, index, start }) => (
        <div
          key={rowKey?.(index) ?? key}
          style={{
            position: "absolute",
            top: start,
            left: 0,
            width: "100%",
            height: ROW_HEIGHT_PX,
          }}
        >
          {renderRow(index)}
        </div>
      ))}
    </div>
  );
}
