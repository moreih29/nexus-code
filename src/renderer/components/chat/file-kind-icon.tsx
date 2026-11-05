// A file's icon by its kind, where the conversation and the side panel
// name a file.

import {
  FileAudio,
  FileBraces,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  Folder,
  type LucideIcon,
  Presentation,
} from "lucide-react";
import { type FileKind, fileKind } from "../../services/chat/links";

const ICONS: Record<FileKind, LucideIcon> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  font: FileType,
  pdf: FileText,
  sheet: FileSpreadsheet,
  doc: FileText,
  slides: Presentation,
  data: FileBraces,
  page: FileText,
  code: FileCode,
  text: FileText,
  folder: Folder,
};

export function FileKindIcon({ path, className }: { path: string; className?: string }) {
  const Icon = ICONS[fileKind(path)];
  return <Icon className={className} aria-hidden="true" />;
}
