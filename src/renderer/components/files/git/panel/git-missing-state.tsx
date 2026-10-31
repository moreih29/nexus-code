/**
 * GitMissingState — the Source Control panel's placeholder when the
 * workspace's host has no Git, in place of "Not a Git Repository" and its
 * Initialize button, which would only fail.
 *
 * A local workspace asks for a reopen after the install, not a refresh: the
 * app finds Git on the PATH it started with, and an installer that adds Git
 * to the PATH reaches only programs started after it. An SSH host looks Git
 * up again on each run, so a refresh is enough there.
 */
import { useTranslation } from "react-i18next";
import { hostPlatform } from "../../../../utils/platform";
import { EmptyState } from "../../../ui/empty-state";

/** git-scm.com's download page for each OS the app runs on. */
const GIT_DOWNLOAD_PAGES = {
  win32: "https://git-scm.com/downloads/win",
  darwin: "https://git-scm.com/downloads/mac",
  linux: "https://git-scm.com/downloads/linux",
} as const;

type LocalOs = keyof typeof GIT_DOWNLOAD_PAGES;

function localOs(): LocalOs {
  const platform = hostPlatform();
  return platform === "win32" || platform === "darwin" ? platform : "linux";
}

export interface GitMissingStateProps {
  /** The workspace lives on an SSH host, which is where Git is missing. */
  remote: boolean;
}

export function GitMissingState({ remote }: GitMissingStateProps) {
  const { t } = useTranslation("files");
  if (remote) {
    return (
      <EmptyState
        title={t("git.panel.gitMissing.title")}
        description={t("git.panel.gitMissing.description.ssh")}
      />
    );
  }
  const os = localOs();
  return (
    <EmptyState
      title={t("git.panel.gitMissing.title")}
      description={t(`git.panel.gitMissing.description.${os}`)}
      actionLabel={t("git.panel.gitMissing.download")}
      onAction={() => {
        // The main process opens an https link from a click in the browser.
        window.open(GIT_DOWNLOAD_PAGES[os], "_blank", "noopener,noreferrer");
      }}
    />
  );
}
