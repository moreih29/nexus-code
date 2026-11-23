export function isDocxFile(filePath: string): boolean {
  return /\.(docx|docm)$/i.test(filePath);
}
