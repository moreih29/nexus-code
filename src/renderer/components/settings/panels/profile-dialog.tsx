/**
 * The dialogs of Settings › Claude and Codex: adding or editing a profile
 * (its name, color, folder, what it shares with the default folder, more
 * variables), and signing it in on this machine, where the app makes its
 * folder and links first, then runs `claude auth login` or `codex login`
 * and shows its output, with a field for a code the browser gives.
 */

import { Check, CircleAlert, Loader2 } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  type AgentProfile,
  isDefaultDir,
  isDefaultProfileId,
  PROFILE_COLORS,
  profilesOf,
  SHARABLE_LABELS,
  SHAREABLE,
  SHARED_BY_DEFAULT,
  suggestedProfileDir,
} from "../../../../shared/agent-profiles/profiles";
import type { AgentProfileStatus } from "../../../../shared/agent-profiles/status";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../../ipc/client";
import { statusSummary, useProfileStatusStore } from "../../../services/agent-profiles/status";
import {
  matchOptions,
  tildePath,
  useAgentProfilesStore,
} from "../../../state/stores/agent-profiles";
import { profileColor, profileName } from "../../agent-profiles/profile-badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Dialog } from "../../ui/dialog";
import { DialogHeader } from "../../ui/dialog-header";
import { twinOf } from "./agent-profiles-panel";

const inputClass = cn(
  "w-full rounded-(--radius-control) border border-border bg-background px-2 py-1",
  "text-app-body text-foreground outline-none placeholder:text-muted-foreground",
  "focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60",
);

const AGENT_NAMES: Record<ChatAgent, string> = { claude: "Claude", codex: "Codex" };

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-app-ui-sm text-muted-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-app-ui-sm text-[var(--state-error-fg)]">{error}</p>
      ) : (
        hint && <p className="text-app-ui-sm text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function envText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/** KEY=value lines; null when one is not. */
function parseEnv(text: string): Record<string, string> | null {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    const key = at > 0 ? line.slice(0, at).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
    env[key] = line.slice(at + 1);
  }
  return env;
}

/** Adds a profile (`profile` null), or edits one. */
export function ProfileDialog({
  agent,
  profile,
  onClose,
  onCreated,
}: {
  agent: ChatAgent;
  profile: AgentProfile | null;
  onClose: () => void;
  /** A new profile was saved: its sign-in comes next. */
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const config = useAgentProfilesStore((s) => s.config);
  const saveProfile = useAgentProfilesStore((s) => s.saveProfile);
  const others = useMemo(
    () => profilesOf(config, agent).filter((p) => p.id !== profile?.id),
    [config, agent, profile],
  );
  const isDefault = profile !== null && isDefaultProfileId(profile.id);
  const [name, setName] = useState(profile?.name ?? "");
  const [color, setColor] = useState<string>(
    profile?.color ??
      PROFILE_COLORS.find((c) => !others.some((p) => p.color === c)) ??
      PROFILE_COLORS[0],
  );
  const [dir, setDir] = useState(profile?.dir ?? "");
  const [dirTouched, setDirTouched] = useState(profile !== null);
  const [shared, setShared] = useState<readonly string[]>(
    profile?.shared ?? SHARED_BY_DEFAULT[agent],
  );
  const [env, setEnv] = useState(envText(profile?.env));
  const [saving, setSaving] = useState(false);
  const nameId = useId();
  const dirId = useId();
  const envId = useId();
  const shareId = useId();

  const takenDirs = others.map((p) => p.dir).filter(Boolean);
  const shownDir = dirTouched ? dir : suggestedProfileDir(agent, name, takenDirs);
  const options = matchOptions();
  const dirError = isDefault
    ? null
    : isDefaultDir(agent, shownDir, options)
      ? t("profiles.dialog.folderDefault")
      : takenDirs.some((d) => isDefaultDir(agent, d, options) === false && sameDir(d, shownDir))
        ? t("profiles.dialog.folderTaken")
        : null;
  // A folder there already (one set up by hand) keeps what it links now,
  // rather than losing a link the defaults leave out.
  const [existing, setExisting] = useState(false);
  useEffect(() => {
    if (profile !== null || shownDir.trim() === "" || dirError) {
      setExisting(false);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void ipcCallResult("agentProfiles", "inspect", { agent, dir: shownDir.trim() }).then(
        (result) => {
          if (!live || !result.ok) return;
          setExisting(result.value.exists);
          setShared(result.value.exists ? result.value.linked : SHARED_BY_DEFAULT[agent]);
        },
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [profile, agent, shownDir, dirError]);
  const parsedEnv = parseEnv(env);
  const valid =
    (isDefault || name.trim() !== "") &&
    (isDefault || shownDir.trim() !== "") &&
    !dirError &&
    parsedEnv !== null;

  const browse = async () => {
    const result = await ipcCallResult("dialog", "showOpenDirectory", {
      title: t("profiles.dialog.browseTitle"),
    });
    if (!result.ok || result.value.canceled) return;
    const picked = result.value.filePaths[0];
    if (picked) {
      setDir(tildePath(picked));
      setDirTouched(true);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    const next: AgentProfile = {
      id: profile?.id ?? `${agent}-${crypto.randomUUID().slice(0, 8)}`,
      agent,
      name: name.trim(),
      color,
      dir: isDefault ? "" : shownDir.trim(),
      ...(isDefault ? {} : { shared: SHAREABLE[agent].filter((n) => shared.includes(n)) }),
      ...(parsedEnv && Object.keys(parsedEnv).length > 0 ? { env: parsedEnv } : {}),
    };
    await saveProfile(next);
    if (profile === null) {
      onCreated(next.id);
      return;
    }
    // The links follow what it shares now.
    if (!isDefault) void ipcCallResult("agentProfiles", "prepare", { profileId: next.id });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} size="md">
      <DialogHeader
        title={
          profile === null
            ? t("profiles.dialog.addTitle", { agent: AGENT_NAMES[agent] })
            : t("profiles.dialog.editTitle", { name: profileName(profile, t) })
        }
      />
      <form
        onSubmit={(e) => void submit(e)}
        className="mt-3 flex flex-col gap-3"
        data-testid="profile-form"
      >
        <Field
          label={t("profiles.dialog.name")}
          htmlFor={nameId}
          hint={t("profiles.dialog.nameHint")}
        >
          <input
            id={nameId}
            type="text"
            value={name}
            maxLength={40}
            spellCheck={false}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder={
              isDefault ? t("profiles.default_name") : t("profiles.dialog.namePlaceholder")
            }
            className={inputClass}
          />
        </Field>

        <Field label={t("profiles.dialog.color")}>
          <div className="flex gap-2">
            {PROFILE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={color === c}
                aria-label={c}
                onClick={() => setColor(c)}
                className={cn(
                  "size-5 rounded-full ring-offset-2 ring-offset-background transition-shadow",
                  color === c ? "ring-2 ring-foreground/60" : "hover:ring-1 hover:ring-border",
                )}
                style={{ backgroundColor: profileColor(c) }}
              />
            ))}
          </div>
        </Field>

        {!isDefault && (
          <Field
            label={t("profiles.dialog.folder")}
            htmlFor={dirId}
            hint={t(existing ? "profiles.dialog.folderExists" : "profiles.dialog.folderHint")}
            error={dirError}
          >
            <div className="flex gap-2">
              <input
                id={dirId}
                type="text"
                value={shownDir}
                spellCheck={false}
                disabled={profile !== null}
                onChange={(e) => {
                  setDir(e.target.value);
                  setDirTouched(true);
                }}
                className={cn(inputClass, "font-mono")}
              />
              {profile === null && (
                <Button type="button" variant="outline" size="sm" onClick={() => void browse()}>
                  {t("profiles.dialog.browse")}
                </Button>
              )}
            </div>
          </Field>
        )}

        {!isDefault && (
          <Field label={t("profiles.dialog.share")} hint={t("profiles.dialog.shareHint")}>
            <div className="grid grid-cols-3 gap-x-3 gap-y-1.5 py-0.5">
              {SHAREABLE[agent].map((entry) => (
                <label
                  key={entry}
                  htmlFor={`${shareId}-${entry}`}
                  className="flex cursor-pointer items-center gap-1.5 text-app-ui-sm"
                >
                  <Checkbox
                    id={`${shareId}-${entry}`}
                    checked={shared.includes(entry)}
                    onCheckedChange={(on) =>
                      setShared((prev) =>
                        on === true ? [...prev, entry] : prev.filter((n) => n !== entry),
                      )
                    }
                  />
                  <span className="font-mono">{SHARABLE_LABELS[entry] ?? entry}</span>
                </label>
              ))}
            </div>
          </Field>
        )}

        <details className="group" open={env !== ""}>
          <summary className="cursor-pointer select-none text-app-ui-sm text-muted-foreground hover:text-foreground">
            {t("profiles.dialog.env")}
          </summary>
          <textarea
            id={envId}
            value={env}
            rows={3}
            spellCheck={false}
            onChange={(e) => setEnv(e.target.value)}
            placeholder={t("profiles.dialog.envPlaceholder")}
            aria-label={t("profiles.dialog.env")}
            className={cn(
              inputClass,
              "mt-1.5 resize-y font-mono",
              parsedEnv === null && "border-[var(--state-error-fg)]",
            )}
          />
        </details>

        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("common:action.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={!valid || saving}>
            {profile === null ? t("profiles.dialog.create") : t("profiles.dialog.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => p.trim().replace(/[\\/]+$/, "");
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

type Prepared = { dir: string; linked: string[]; failed: string[] };

/** Splits the output into text and https links, which open in the browser. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https:\/\/[^\s"'<>]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("https://") ? (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts are fixed for a text
            key={i}
            type="button"
            className="break-all text-left text-[var(--state-info-fg)] underline underline-offset-2"
            onClick={() => void ipcCallResult("agentProfiles", "openUrl", { url: part })}
          >
            {part}
          </button>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are fixed for a text
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function Step({ state, children }: { state: "done" | "busy" | "failed"; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {state === "done" && (
          <Check className="size-3.5 text-[var(--state-success-fg)]" aria-hidden="true" />
        )}
        {state === "busy" && (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
        )}
        {state === "failed" && (
          <CircleAlert className="size-3.5 text-[var(--state-error-fg)]" aria-hidden="true" />
        )}
      </span>
      <div className="min-w-0 flex-1 text-app-body">{children}</div>
    </div>
  );
}

/** Makes the profile's folder and links, then runs its sign-in here. */
export function LoginDialog({
  profileId,
  agent,
  onClose,
}: {
  profileId: string;
  agent: ChatAgent;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const config = useAgentProfilesStore((s) => s.config);
  const profiles = useMemo(() => profilesOf(config, agent), [config, agent]);
  const profile = profiles.find((p) => p.id === profileId);
  const statuses = useProfileStatusStore((s) => s.byId);
  const refresh = useProfileStatusStore((s) => s.refresh);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<{ id: string; command: string } | null>(null);
  const [output, setOutput] = useState("");
  const [exit, setExit] = useState<{ code: number | null } | null>(null);
  const [status, setStatus] = useState<AgentProfileStatus | undefined>(undefined);
  const [code, setCode] = useState("");
  const [round, setRound] = useState(0);
  const [already, setAlready] = useState(false);
  const loginRef = useRef<string | null>(null);

  useEffect(() => {
    const offOut = ipcListen("agentProfiles", "loginOutput", ({ id, text }) => {
      if (id === loginRef.current) setOutput((prev) => (prev + text).slice(-20_000));
    });
    const offExit = ipcListen("agentProfiles", "loginExit", ({ id, code }) => {
      if (id !== loginRef.current) return;
      setExit({ code });
      void refresh(profileId).then(setStatus);
    });
    return () => {
      offOut();
      offExit();
      if (loginRef.current)
        void ipcCallResult("agentProfiles", "loginCancel", { id: loginRef.current });
    };
  }, [profileId, refresh]);

  useEffect(() => {
    let live = true;
    setOutput("");
    setExit(null);
    setStatus(undefined);
    setError(null);
    void (async () => {
      try {
        const ready = unwrapIpcResult(
          await ipcCallResult("agentProfiles", "prepare", { profileId }),
        );
        if (!live) return;
        setPrepared(ready);
        // A folder signed in already (one the user made before) is not signed
        // in again unless they ask to.
        if (round === 0) {
          const current = await refresh(profileId);
          if (!live) return;
          if (current?.state === "signed-in") {
            setStatus(current);
            setAlready(true);
            return;
          }
        }
        setAlready(false);
        const started = unwrapIpcResult(
          await ipcCallResult("agentProfiles", "loginStart", { profileId }),
        );
        if (!live) {
          void ipcCallResult("agentProfiles", "loginCancel", { id: started.id });
          return;
        }
        loginRef.current = started.id;
        setLogin(started);
      } catch (err) {
        if (live) setError((err as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [profileId, round, refresh]);

  if (!profile) return null;
  const name = profileName(profile, t);
  const running = login !== null && exit === null && !error;
  const signedIn = status?.state === "signed-in" ? status : null;
  const twin = signedIn
    ? twinOf(agent, profile, profiles, { ...statuses, [profile.id]: { status } })
    : undefined;
  const loginState: "done" | "busy" | "failed" = signedIn
    ? "done"
    : exit !== null || error
      ? "failed"
      : "busy";

  const sendCode = (e: FormEvent) => {
    e.preventDefault();
    if (!login || code.trim() === "") return;
    void ipcCallResult("agentProfiles", "loginInput", { id: login.id, text: code.trim() });
    setCode("");
  };

  const close = () => {
    if (running && login) void ipcCallResult("agentProfiles", "loginCancel", { id: login.id });
    loginRef.current = null;
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()} size="lg">
      <DialogHeader title={t("profiles.loginDialog.title", { name })} />
      <div className="mt-3 flex flex-col gap-2.5" data-testid="profile-login">
        {!isDefaultProfileId(profile.id) && (
          <Step state={prepared ? "done" : error ? "failed" : "busy"}>
            {t("profiles.loginDialog.folder")}{" "}
            <span className="font-mono text-app-ui-sm text-muted-foreground">
              {tildePath(profile.dir)}
            </span>
          </Step>
        )}
        {prepared && prepared.linked.length + prepared.failed.length > 0 && (
          <Step state={prepared.failed.length > 0 ? "failed" : "done"}>
            {t("profiles.loginDialog.linked", { count: prepared.linked.length })}
            {prepared.failed.length > 0 && (
              <span className="ml-2 text-app-ui-sm text-[var(--state-error-fg)]">
                {t("profiles.loginDialog.linkFailed", { names: prepared.failed.join(", ") })}
              </span>
            )}
          </Step>
        )}
        <Step state={loginState}>
          <div className="flex flex-col gap-1.5">
            <span>
              {running ? t("profiles.loginDialog.waiting") : t("profiles.loginDialog.signIn")}
            </span>
            {(login || error) && (
              <pre className="app-scrollbar max-h-48 overflow-auto whitespace-pre-wrap rounded-(--radius-control) border border-border bg-muted/40 px-2 py-1.5 font-mono text-app-micro text-muted-foreground">
                {login && (
                  <span className="text-foreground">
                    $ {login.command}
                    {"\n"}
                  </span>
                )}
                <Linkified text={output} />
                {error && <span className="text-[var(--state-error-fg)]">{error}</span>}
              </pre>
            )}
            {running && agent === "claude" && (
              <form onSubmit={sendCode} className="flex gap-2">
                <input
                  type="text"
                  value={code}
                  spellCheck={false}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder={t("profiles.loginDialog.codePlaceholder")}
                  className={cn(inputClass, "font-mono")}
                />
                <Button type="submit" variant="outline" size="sm" disabled={code.trim() === ""}>
                  {t("profiles.loginDialog.send")}
                </Button>
              </form>
            )}
          </div>
        </Step>

        {signedIn && (
          <div className="flex flex-col gap-1 rounded-(--radius-control) border border-border px-3 py-2">
            <span className="text-app-body text-foreground">
              {t(already ? "profiles.loginDialog.already" : "profiles.loginDialog.done", {
                who: statusSummary(agent, signedIn, {
                  personal: t("profiles.status.personalOrg"),
                  apiKey: t("profiles.status.apiKey"),
                  signedIn: t("profiles.status.signedIn"),
                }).text,
              })}
            </span>
            {signedIn.orgName && (
              <span className="text-app-ui-sm text-muted-foreground">{signedIn.orgName}</span>
            )}
            {twin && (
              <span className="text-app-ui-sm text-[var(--state-warning-fg)]">
                {agent === "claude"
                  ? t("profiles.loginDialog.sameOrg", { name: profileName(twin, t) })
                  : t("profiles.loginDialog.sameAccount", { name: profileName(twin, t) })}
              </span>
            )}
          </div>
        )}
        {exit !== null && !signedIn && status !== undefined && (
          <p className="text-app-ui-sm text-[var(--state-error-fg)]">
            {t("profiles.loginDialog.failed")}
          </p>
        )}

        <div className="mt-1 flex justify-end gap-2">
          {(exit !== null || error || already) && (
            <Button variant="outline" size="sm" onClick={() => setRound((n) => n + 1)}>
              {t("profiles.loginDialog.retry")}
            </Button>
          )}
          <Button size="sm" variant={running ? "ghost" : "default"} onClick={close}>
            {running ? t("profiles.loginDialog.cancel") : t("profiles.loginDialog.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
