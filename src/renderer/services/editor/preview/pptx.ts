export function isPresentationFile(filePath: string): boolean {
  return /\.(pptx|pptm|ppsx)$/i.test(filePath);
}
