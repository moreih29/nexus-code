// PowerPoint presentations, which the editor shows as their slides rather
// than opens in Monaco.

export function isPresentationFile(filePath: string): boolean {
  return /\.(pptx|pptm|ppsx)$/i.test(filePath);
}
