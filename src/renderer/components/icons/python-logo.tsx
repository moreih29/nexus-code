/**
 * Python logo — stylized monochromatic mark using the two-snake silhouette
 * simplified to a single-color currentColor path.
 *
 * ViewBox 24×24, rendered at 16×16 by default.
 */

export function PythonLogo({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      {/* Upper snake body */}
      <path d="M11.97 2C9.19 2 7.5 3.27 7.5 5.25V7h4.5v.75H5.25C3.27.75 2 9.44 2 11.97c0 2.4 1.3 3.78 3.25 3.78H6.5v-2c0-2.03 1.47-3.25 3.47-3.25h4.06c1.73 0 3-1.22 3-3V5.25C17 3.27 15.03 2 12.03 2h-.06zm-1.72 1.75a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5z" />
      {/* Lower snake body */}
      <path d="M12.03 22c2.8 0 4.47-1.27 4.47-3.25V17h-4.5v-.75h6.75C20.73 16.25 22 14.56 22 12.03c0-2.4-1.3-3.78-3.25-3.78H17.5v2c0 2.03-1.47 3.25-3.47 3.25H9.97c-1.73 0-3 1.22-3 3v3.5C6.97 20.73 8.97 22 12 22h.03zm1.72-1.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z" />
    </svg>
  );
}
