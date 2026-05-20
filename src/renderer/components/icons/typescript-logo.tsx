/**
 * TypeScript logo — rounded square with "TS" letterform.
 * Monochromatic: uses only `currentColor` so callers control the fill
 * via `className="text-*"` or inline `style={{ color: "..." }}`.
 *
 * ViewBox 24×24, rendered at 16×16 by default.
 */

export function TypeScriptLogo({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      {/* Rounded-rectangle background */}
      <rect x="2" y="2" width="20" height="20" rx="3" ry="3" />
      {/* "TS" letterform cut out in white */}
      <path
        fill="white"
        d="M5 10.5h5.5V12H8v6H6.5v-6H5v-1.5zm7.5 0h4.25c.83 0 1.25.45 1.25 1.1v.9h-1.4v-.5c0-.2-.1-.3-.3-.3h-1.4c-.2 0-.3.1-.3.3v.7c0 .2.1.3.3.35l2.2.6c.7.2 1.15.65 1.15 1.45v.8c0 .85-.5 1.35-1.5 1.35H12.5c-.85 0-1.3-.45-1.3-1.1v-.9h1.4v.45c0 .2.1.3.3.3h1.6c.2 0 .3-.1.3-.3v-.8c0-.2-.1-.3-.3-.35l-2.2-.6c-.7-.2-1.1-.6-1.1-1.4v-.75c0-.85.5-1.35 1.5-1.35z"
      />
    </svg>
  );
}
