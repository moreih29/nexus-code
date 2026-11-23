export interface NoteHost {
  assetUrl(src: string, version?: number): Promise<string>;
  readText(src: string): Promise<string | null>;
  saveSketch(sketch: {
    id?: string;
    scene: string;
    svg: string;
  }): Promise<{ id: string; src: string }>;
  openAsset(src: string): void;
  revealAsset(src: string): void;
  openWorkspaceFile(path: string): void;
  language(): string;
}
