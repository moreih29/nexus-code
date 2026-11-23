import { useEffect } from "react";

export function useGlobalSearchHotkey(inputRef: React.RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        const input = inputRef.current;
        input?.focus();
        input?.select();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [inputRef]);
}
