/**
 * What a note's editor blocks need from the note they are in: its files
 * (pictures to show, a sketch's scene to load) and where to save a sketch.
 * The note editor makes one per open note and hands it to the extensions.
 */
export interface NoteHost {
  /** A URL the editor can show a file of the note's folder by ("sketches/…svg"). */
  assetUrl(src: string, version?: number): Promise<string>;
  /** A text file of the note's folder, or null if it is not there. */
  readText(src: string): Promise<string | null>;
  /** Saves a sketch's scene and picture; a new sketch (no id) gets one. */
  saveSketch(sketch: {
    id?: string;
    scene: string;
    svg: string;
  }): Promise<{ id: string; src: string }>;
  /** Opens a file of the note's folder with the system's app for it. */
  openAsset(src: string): void;
  /** Shows a file of the note's folder in Finder (Explorer, the file manager). */
  revealAsset(src: string): void;
  /** Opens a workspace file a link points at ("workspace:src/a.ts"). */
  openWorkspaceFile(path: string): void;
  /** The app's language, as i18next has it ("ko", "en"). */
  language(): string;
}
