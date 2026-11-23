/**
 * The consent prompts waiting on the user here, as another device of
 * theirs sees them in the sessions' list (`consents`), and answers one
 * (consent.answer) as the user would at this computer: where they are not
 * at it, a phone may let an agent go on, or turn it down.
 *
 * A device answers only what it could do itself: a prompt needs the chats'
 * controls there (chat.control), and a change to a terminal the terminals'
 * too (terminal.control). The device whose agent asks may answer it too,
 * as any other: the user does, at its screen. No agent allows itself: the
 * room refuses consent.answer sent with `from`, and the nexus command never
 * sends it.
 */
import {
  type ConsentAnswer,
  type RemoteConsent,
  RpcErrorCode,
} from "../../../../packages/remote-protocol/src";
import { consentDetailsOf } from "../../../shared/cli/consent-copy";
import { isTerminalChange } from "../../../shared/cli/ui";
import { getMainI18n, tryGetMainT } from "../../i18n";
import type { CliServices, PendingConsent } from "../cli/context";
import { RpcFailure } from "./room";

/** What the user lets other devices control here (Settings › Remote). */
export interface ConsentControls {
  readonly chat: boolean;
  readonly terminal: boolean;
}

/**
 * The most of a prompt's body (the command, what would be typed, the
 * message) another device is told: a list of prompts goes in one answer.
 */
export const MAX_REMOTE_BODY_CHARS = 8000;

export const UNTIMED_EXPIRES_AFTER_MS = 24 * 60 * 60_000;

/** Whether another device may answer `pending`, and why not when not. */
export function refusalFor(pending: PendingConsent, controls: ConsentControls): string | null {
  const { request } = pending;
  // What another device cannot show whole is not allowed from it.
  if ((request.change.body?.length ?? 0) > MAX_REMOTE_BODY_CHARS) {
    return "it is too long to show whole there: the user answers it at this computer";
  }
  if (!controls.chat) return "control of the chats is off there (Settings › Remote)";
  if (isTerminalChange(request.change) && !controls.terminal) {
    return "control of the terminals is off there (Settings › Remote)";
  }
  return null;
}

/** The prompts waiting on the user, as another device is told them, oldest first. */
export async function remoteConsents(
  services: CliServices,
  controls: ConsentControls,
  now = Date.now(),
  listTabs = (workspaceId: string): Promise<readonly { id: string; title: string }[]> =>
    services.ui("tabs.list", { workspaceId }).then((r) => r.tabs),
): Promise<RemoteConsent[]> {
  const pending = services.consents.list();
  if (pending.length === 0) return [];
  // The asking tabs' titles, a workspace's tabs looked up once.
  const tabs = new Map<string, Promise<readonly { id: string; title: string }[]>>();
  const titleOf = async (workspaceId: string, tabId: string) => {
    let listed = tabs.get(workspaceId);
    if (!listed) {
      listed = listTabs(workspaceId).catch(() => []);
      tabs.set(workspaceId, listed);
    }
    return (await listed).find((t) => t.id === tabId)?.title;
  };
  const workspaces = services.listWorkspaces();
  const t = tryGetMainT() ? getMainI18n().getFixedT(null, "settings") : undefined;
  return Promise.all(
    pending.map(async (p): Promise<RemoteConsent> => {
      const { request } = p;
      const remote = request.fromDevice !== undefined && request.fromDeviceId !== undefined;
      const workspaceName = remote
        ? undefined
        : workspaces.find((w) => w.id === request.fromWorkspaceId)?.name;
      const name =
        request.fromName ??
        (remote ? undefined : await titleOf(request.fromWorkspaceId, request.fromTabId));
      const { kind, instructionEdit, profileAdd } = request.change;
      // Keep display text for peers that only know detail and body.
      const { detail, body } =
        t && (instructionEdit || profileAdd) ? consentDetailsOf(t, request.change) : request.change;
      const expiresAt = p.expiresAt ?? p.at + UNTIMED_EXPIRES_AFTER_MS;
      return {
        id: p.id,
        at: p.at,
        expiresAt,
        expiresInMs: Math.max(0, Math.round(expiresAt - now)),
        from: {
          ...(remote
            ? { device: { id: request.fromDeviceId as string, name: request.fromDevice as string } }
            : {}),
          workspaceId: request.fromWorkspaceId,
          ...(workspaceName !== undefined ? { workspaceName } : {}),
          tabId: request.fromTabId,
          ...(name !== undefined ? { name } : {}),
        },
        workspaceId: request.toWorkspaceId,
        change: {
          kind,
          ...(detail !== undefined ? { detail } : {}),
          ...(body !== undefined ? { body: clipBody(body) } : {}),
          ...(instructionEdit ? { instructionEdit } : {}),
          ...(profileAdd ? { profileAdd } : {}),
        },
        eachTime: request.change.eachTime === true,
        answerable: refusalFor(p, controls) === null,
        ...(p.expiresAt === undefined ? { untimed: true as const } : {}),
      };
    }),
  );
}

function clipBody(body: string): string {
  if (body.length <= MAX_REMOTE_BODY_CHARS) return body;
  const more = body.length - MAX_REMOTE_BODY_CHARS;
  return `${body.slice(0, MAX_REMOTE_BODY_CHARS)}\n… (${more} more characters: see it whole at the computer)`;
}

/**
 * Answers the prompt `id` from `device`, the answer told as by its name:
 * NotFound once it no longer waits, Forbidden when another device may not
 * answer it.
 */
export async function answerConsent(
  services: CliServices,
  device: { readonly id: string; readonly name: string },
  controls: ConsentControls,
  { id, answer }: { id: string; answer: ConsentAnswer },
): Promise<Record<string, never>> {
  const pending = services.consents.list().find((p) => p.id === id);
  if (!pending) {
    throw new RpcFailure(
      RpcErrorCode.NotFound,
      "no such prompt: answered, or no longer asked, since",
    );
  }
  const refusal = refusalFor(pending, controls);
  if (refusal) throw new RpcFailure(RpcErrorCode.Forbidden, refusal);
  if (answer === "session" && pending.request.change.eachTime) {
    throw new RpcFailure(RpcErrorCode.Forbidden, "this request can only be allowed once");
  }
  if (!(await services.consents.answer(id, answer, device.name))) {
    throw new RpcFailure(
      RpcErrorCode.NotFound,
      "no such prompt: answered, or no longer asked, since",
    );
  }
  return {};
}
