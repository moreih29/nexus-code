export function isPdfFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".pdf");
}

export const PDF_ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function nextZoomStep(scale: number, direction: 1 | -1): number {
  const steps = direction === 1 ? PDF_ZOOM_STEPS : [...PDF_ZOOM_STEPS].reverse();
  const next = steps.find((step) => (direction === 1 ? step > scale + 1e-3 : step < scale - 1e-3));
  return next ?? scale;
}
