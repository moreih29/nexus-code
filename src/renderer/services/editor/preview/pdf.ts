// PDF files, which the editor shows page by page rather than opens in Monaco.

export function isPdfFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".pdf");
}

/** Bytes from base64, as fs.readBinary gives a file. */
export function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The zoom steps the toolbar's buttons go through, as fractions of actual size. */
export const PDF_ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** The next step from `scale`, in `direction`; `scale` itself at either end. */
export function nextZoomStep(scale: number, direction: 1 | -1): number {
  const steps = direction === 1 ? PDF_ZOOM_STEPS : [...PDF_ZOOM_STEPS].reverse();
  // A small margin keeps a scale just off a step from landing back on it.
  const next = steps.find((step) => (direction === 1 ? step > scale + 1e-3 : step < scale - 1e-3));
  return next ?? scale;
}
