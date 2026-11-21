// src/renderer/components/settings/panels/sign-in-buttons.tsx
//
// The sign-in buttons of the Remote page, one per sign-in the server
// offers. Google's follows Google's sign-in branding: its multicolor "G"
// unmodified, "Sign in with Google", Roboto Medium, 40px high, white with
// a #747775 border on a light theme and #131314 with #8E918F on a dark one.
// Apple's uses white on black in light themes and black on white in dark
// themes. GitHub's carries the Invertocat in the theme's text color. The
// dev sign-in is marked as local only.

import { useTranslation } from "react-i18next";
import { THEME_SOURCE_BY_ID } from "../../../../shared/design-tokens";
import type { SignInProvider } from "../../../../shared/remote/account";
import { useThemeStore } from "../../../state/stores/theme";
import { cn } from "../../../utils/cn";

/** Apple's sign-in mark, as used in the mobile app. */
function AppleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="17 14.5 22 22" aria-hidden="true" className={className} fill="currentColor">
      <path d="M28.2226562,20.3846154 C29.0546875,20.3846154 30.0976562,19.8048315 30.71875,19.0317864 C31.28125,18.3312142 31.6914062,17.352829 31.6914062,16.3744437 C31.6914062,16.2415766 31.6796875,16.1087095 31.65625,16 C30.7304687,16.0362365 29.6171875,16.640178 28.9492187,17.4494596 C28.421875,18.06548 27.9414062,19.0317864 27.9414062,20.0222505 C27.9414062,20.1671964 27.9648438,20.3121424 27.9765625,20.3604577 C28.0351562,20.3725366 28.1289062,20.3846154 28.2226562,20.3846154 Z M25.2929688,35 C26.4296875,35 26.9335938,34.214876 28.3515625,34.214876 C29.7929688,34.214876 30.109375,34.9758423 31.375,34.9758423 C32.6171875,34.9758423 33.4492188,33.792117 34.234375,32.6325493 C35.1132812,31.3038779 35.4765625,29.9993643 35.5,29.9389701 C35.4179688,29.9148125 33.0390625,28.9122695 33.0390625,26.0979021 C33.0390625,23.6579784 34.9140625,22.5588048 35.0195312,22.474253 C33.7773438,20.6382708 31.890625,20.5899555 31.375,20.5899555 C29.9804688,20.5899555 28.84375,21.4596313 28.1289062,21.4596313 C27.3554688,21.4596313 26.3359375,20.6382708 25.1289062,20.6382708 C22.8320312,20.6382708 20.5,22.5950413 20.5,26.2911634 C20.5,28.5861411 21.3671875,31.013986 22.4335938,32.5842339 C23.3476562,33.9129053 24.1445312,35 25.2929688,35 Z" />
    </svg>
  );
}

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
  if (provider === "apple") {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        data-provider="apple"
        className={cn(
          base,
          "text-app-body-emphasis font-medium",
          light
            ? "border-black bg-black text-white hover:bg-neutral-900"
            : "border-white bg-white text-black hover:bg-neutral-100",
        )}
      >
        <AppleMark className="size-5 shrink-0" />
        <span>{label}</span>
      </button>
    );
  }
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
