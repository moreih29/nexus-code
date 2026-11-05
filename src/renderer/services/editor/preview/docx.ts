// Word documents, which the editor shows laid out as pages rather than
// opens in Monaco.

export function isDocxFile(filePath: string): boolean {
  return /\.(docx|docm)$/i.test(filePath);
}
