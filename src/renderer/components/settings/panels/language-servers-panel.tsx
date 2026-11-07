// src/renderer/components/settings/panels/language-servers-panel.tsx
//
// Controls:
//   - Master switch
//   - Bundled servers: one checkbox each, two to a line; TypeScript's memory
//     saver under its own
//   - Servers the user installs (Go, Rust): checkbox, path, install command
//   - How many workspaces run servers at once
//
// Main applies each change at once — stopping, starting or restarting the
// servers it affects — and broadcasts the result, which the store mirrors.

import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { type BuiltinLspPresetLanguageId, resolveLspPreset } from "../../../../shared/lsp/config";
import {
  isLspLowMemory,
  LSP_MAX_ACTIVE_WORKSPACES_LIMIT,
  type LspLanguageSettings,
} from "../../../../shared/lsp/settings";
import { ipcCallResult } from "../../../ipc/client";
import { useLspSettingsStore } from "../../../state/stores/lsp-settings";
import { isWindows } from "../../../utils/platform";
import { Checkbox } from "../../ui/checkbox";
import { NumberInput } from "../../ui/number-input";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSwitch } from "../section";

const BUNDLED_LANGUAGES: readonly BuiltinLspPresetLanguageId[] = [
  "typescript",
  "python",
  "yaml",
  "shell",
  "dockerfile",
];

const INSTALLED_LANGUAGES: readonly BuiltinLspPresetLanguageId[] = ["go", "rust"];

export function LanguageServersPanel() {
  const { t } = useTranslation("settings");
  const settings = useLspSettingsStore((s) => s.settings);

  return (
    <SettingsPage>
      <SettingsGroup>
        <SettingsSwitch
          label={t("languageServers.enable")}
          description={t("languageServers.description")}
          checked={settings.enabled}
          onChange={(v) => void ipcCallResult("lsp", "setEnabled", { enabled: v })}
        />
      </SettingsGroup>

      {settings.enabled && (
        <>
          <SettingsGroup title={t("languageServers.bundled")}>
            <LanguageGrid>
              {BUNDLED_LANGUAGES.map((languageId) => (
                <LanguageRow
                  key={languageId}
                  languageId={languageId}
                  settings={settings.languages[languageId] ?? {}}
                />
              ))}
            </LanguageGrid>
          </SettingsGroup>

          <SettingsGroup
            title={t("languageServers.installed")}
            description={t("languageServers.installedDescription")}
          >
            <LanguageGrid>
              {INSTALLED_LANGUAGES.map((languageId) => (
                <LanguageRow
                  key={languageId}
                  languageId={languageId}
                  settings={settings.languages[languageId] ?? {}}
                />
              ))}
            </LanguageGrid>
          </SettingsGroup>

          <SettingsGroup>
            <SettingsRow
              label={t("languageServers.maxWorkspaces")}
              description={t("languageServers.maxWorkspacesDescription")}
            >
              <NumberInput
                value={settings.maxActiveWorkspaces}
                onChange={(count) => void ipcCallResult("lsp", "setMaxActiveWorkspaces", { count })}
                min={1}
                max={LSP_MAX_ACTIVE_WORKSPACES_LIMIT}
                ariaLabel={t("languageServers.maxWorkspaces")}
              />
            </SettingsRow>
          </SettingsGroup>
        </>
      )}
    </SettingsPage>
  );
}

/** Languages two to a line: each is a checkbox and a few words at most. */
function LanguageGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 items-start gap-x-4 gap-y-2.5">{children}</div>;
}

function LanguageRow({
  languageId,
  settings,
}: {
  languageId: BuiltinLspPresetLanguageId;
  settings: LspLanguageSettings;
}) {
  const { t } = useTranslation("settings");
  const id = useId();
  const lowMemoryId = useId();
  const preset = resolveLspPreset(languageId);
  // A server the user installs runs only once turned on.
  const on = preset?.system ? settings.enabled === true : settings.enabled !== false;

  function change(next: LspLanguageSettings): void {
    void ipcCallResult("lsp", "setLanguageSettings", { languageId, settings: next });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="flex items-center gap-2 cursor-pointer">
        <Checkbox id={id} checked={on} onCheckedChange={(v) => change({ enabled: v === true })} />
        <span className="text-app-body text-foreground">
          {t(`languageServers.language.${languageId}`)}
        </span>
      </label>
      {on && languageId === "typescript" && (
        <div className="flex flex-col gap-1 pl-6">
          <label htmlFor={lowMemoryId} className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              id={lowMemoryId}
              checked={isLspLowMemory(settings)}
              onCheckedChange={(v) => change({ lowMemory: v === true })}
            />
            <span className="text-app-body text-foreground">{t("languageServers.lowMemory")}</span>
          </label>
          <p className="pl-6 text-app-ui-sm text-muted-foreground">
            {t("languageServers.lowMemoryDescription")}
          </p>
        </div>
      )}
      {on && preset?.system && (
        <ServerPathField
          languageId={languageId}
          install={preset.install}
          path={settings.path ?? ""}
          onCommit={(path) => change({ path })}
        />
      )}
    </div>
  );
}

/**
 * Where a server the user installed is. Saved on Enter, leaving the field or
 * closing the page, not per keystroke: each change restarts the language's
 * servers.
 */
function ServerPathField({
  languageId,
  install,
  path,
  onCommit,
}: {
  languageId: BuiltinLspPresetLanguageId;
  install: string | undefined;
  path: string;
  onCommit: (path: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [draft, setDraft] = useState(path);
  // What the field last saved or was given, so a draft is saved once.
  const savedRef = useRef(path.trim());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  useEffect(() => {
    setDraft(path);
    savedRef.current = path.trim();
  }, [path]);

  function commit(): void {
    const next = draftRef.current.trim();
    if (next === savedRef.current) return;
    savedRef.current = next;
    onCommitRef.current(next);
  }

  // Escape closes the dialog without leaving the field: save on the way out.
  // biome-ignore lint/correctness/useExhaustiveDependencies: commit reads refs only
  useEffect(() => commit, []);

  return (
    <div className="flex flex-col gap-1 pl-6">
      <input
        type="text"
        value={draft}
        maxLength={4096}
        spellCheck={false}
        aria-label={t("languageServers.serverPath", {
          language: t(`languageServers.language.${languageId}`),
        })}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        placeholder={t(
          `languageServers.serverPathPlaceholder.${languageId}${isWindows() ? "Windows" : ""}`,
        )}
        className={cn(
          "w-full rounded-(--radius-control) border border-border bg-background px-2 py-1",
          "font-mono text-app-body text-foreground outline-none placeholder:text-muted-foreground",
          "focus-visible:ring-1 focus-visible:ring-ring",
        )}
      />
      {install && (
        <p className="text-app-ui-sm text-muted-foreground">
          {t("languageServers.install")}{" "}
          <code className="font-mono select-text break-all">{install}</code>
        </p>
      )}
    </div>
  );
}
