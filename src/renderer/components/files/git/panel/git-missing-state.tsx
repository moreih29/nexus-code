import { useTranslation } from "react-i18next";
import { hostPlatform } from "../../../../utils/platform";
import { EmptyState } from "../../../ui/empty-state";

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
        window.open(GIT_DOWNLOAD_PAGES[os], "_blank", "noopener,noreferrer");
      }}
    />
  );
}
