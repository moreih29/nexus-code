// src/renderer/components/settings/panels/sign-in-buttons.tsx
//
// The sign-in buttons of the Remote page, one per sign-in the server
// offers. Google's follows Google's sign-in branding: its multicolor "G"
// unmodified, "Sign in with Google", Roboto Medium, 40px high, white with
// a #747775 border on a light theme and #131314 with #8E918F on a dark one.
// GitHub's carries the Invertocat in the theme's text color. The dev
// server's says it is only for a local server. The marks are drawn here,
// not loaded.

import { useTranslation } from "react-i18next";
import { THEME_SOURCE_BY_ID } from "../../../../shared/design-tokens";
import type { SignInProvider } from "../../../../shared/remote/account";
import { useThemeStore } from "../../../state/stores/theme";
import { cn } from "../../../utils/cn";

/** Google's "G", as its sign-in button carries it. */
export function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={className}>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** GitHub's Invertocat, in the color of the text around it. */
export function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="currentColor">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

const base = cn(
  "inline-flex h-10 cursor-pointer items-center gap-2.5 rounded-(--radius-xs) border px-3",
  "transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
  "disabled:pointer-events-none disabled:opacity-50",
);

export function SignInButton({
  provider,
  onClick,
  disabled,
}: {
  provider: SignInProvider;
  onClick: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("settings");
  const light = useThemeStore((s) => THEME_SOURCE_BY_ID[s.resolved].base === "light");
  const label = t(`remote.account.signInWith.${provider}`);
  if (provider === "google") {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        data-provider="google"
        style={{ fontFamily: "Roboto, Pretendard, sans-serif" }}
        className={cn(
          base,
          "text-app-body-emphasis leading-5 font-medium",
          light
            ? "border-[#747775] bg-white text-[#1F1F1F] hover:bg-[#F8F8F8]"
            : "border-[#8E918F] bg-[#131314] text-[#E3E3E3] hover:bg-[#1F1F21]",
        )}
      >
        <GoogleMark className="size-5 shrink-0" />
        <span>{label}</span>
      </button>
    );
  }
  if (provider === "github") {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        data-provider="github"
        className={cn(
          base,
          "border-border bg-background text-app-body-emphasis font-medium text-foreground hover:bg-[var(--state-hover-bg)]",
        )}
      >
        <GitHubMark className="size-5 shrink-0" />
        <span>{label}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-provider="dev"
      className={cn(
        base,
        "border-dashed border-border bg-transparent text-app-body-emphasis text-foreground hover:bg-[var(--state-hover-bg)]",
      )}
    >
      <span>{label}</span>
      <span className="rounded-(--radius-pill) border border-border px-1.5 text-app-micro text-muted-foreground">
        {t("remote.account.localOnly")}
      </span>
    </button>
  );
}
