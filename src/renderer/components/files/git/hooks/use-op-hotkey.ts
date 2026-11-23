import { useCallback } from "react";

interface UseGitOpHotkeyOptions {
  disabled?: boolean;
  onCommit: () => void;
}

export function useGitOpHotkey({
  disabled = false,
  onCommit,
}: UseGitOpHotkeyOptions): (event: React.KeyboardEvent<HTMLElement>) => void {
  return useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (!disabled) onCommit();
      }
    },
    [disabled, onCommit],
  );
}
