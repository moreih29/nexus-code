// Audio and video files, which the editor plays rather than opens in Monaco.

export type MediaKind = "audio" | "video";

const AUDIO_EXTENSIONS = [".mp3", ".wav", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".flac"];
const VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".webm", ".ogv"];

/** Whether `filePath` is played as audio or video, by its extension; null if neither. */
export function mediaKindFor(filePath: string): MediaKind | null {
  const lower = filePath.toLowerCase();
  if (AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "audio";
  if (VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "video";
  return null;
}

/** A length in seconds as a clock shows it: m:ss, or h:mm:ss from an hour. */
export function mediaDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
