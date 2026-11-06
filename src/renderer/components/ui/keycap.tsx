// A key on a button or a row, telling the key that does the same: ↵ on the
// button Enter presses, 1 on the option the 1 key picks. Drawn in the colour
// of the text around it.

import { cn } from "@/utils/cn";

export function Keycap({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      aria-hidden
      className={cn(
        "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[3px] border border-current/40 px-1 font-sans text-app-micro leading-none opacity-80",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
