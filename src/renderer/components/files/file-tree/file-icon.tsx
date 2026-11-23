import { useIconThemeStore } from "@/state/stores/icon-theme";
import { cn } from "@/utils/cn";
import { type FileIconKind, resolveLucide, resolveMaterialIconName } from "./file-icon-resolvers";

export type { FileIconKind };
export { resolveLucide, resolveMaterialIconName };

type FileIconSize = "sm" | "md";
type FileIconTone = "sidebar" | "muted";

export interface FileIconProps {
  kind: FileIconKind;
  name?: string;
  size?: FileIconSize;
  tone: FileIconTone;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}

const MATERIAL_URL_GLOB = import.meta.glob("@/assets/icons/material/*.svg", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const MATERIAL_URL: Record<string, string> = {};
for (const [path, url] of Object.entries(MATERIAL_URL_GLOB)) {
  const match = path.match(/\/([^/]+)\.svg(?:\?.*)?$/);
  if (match) {
    MATERIAL_URL[match[1]] = url;
  }
}

function resolveMaterial(kind: FileIconKind, name?: string): string | null {
  const iconName = resolveMaterialIconName(kind, name);
  if (!iconName) return null;
  return MATERIAL_URL[iconName] ?? null;
}

const SIZE_PX: Record<FileIconSize, number> = { sm: 12, md: 14 };
const SIZE_CLASS: Record<FileIconSize, string> = { sm: "size-3", md: "size-3.5" };
const TONE_CLASS: Record<FileIconTone, string> = {
  sidebar: "text-[var(--sidebar-icon-fg)]",
  muted: "text-muted-foreground",
};

export function FileIcon({
  kind,
  name,
  size = "sm",
  tone,
  className,
  "aria-hidden": ariaHidden,
}: FileIconProps) {
  const theme = useIconThemeStore((s) => s.resolved);

  if (theme === "material") {
    const src = resolveMaterial(kind, name);
    if (src) {
      const px = SIZE_PX[size];
      return (
        <img
          src={src}
          alt=""
          aria-hidden={ariaHidden}
          width={px}
          height={px}
          className={cn(SIZE_CLASS[size], "object-contain", className)}
        />
      );
    }
  }

  const LucideComp = resolveLucide(kind, name);
  return (
    <LucideComp
      aria-hidden={ariaHidden}
      className={cn(SIZE_CLASS[size], TONE_CLASS[tone], className)}
      strokeWidth={1.5}
    />
  );
}
