/**
 * The consent prompts waiting on the user here, as another device of
 * theirs sees them in the sessions' list (`consents`), and answers one
 * (consent.answer) as the user would at this computer: where they are not
 * at it, a phone may let an agent go on, or turn it down.
 *
 * A device answers only what it could do itself: a prompt needs the chats'
 * controls there (chat.control), and a change to a terminal the terminals'
 * too (terminal.control). The device whose agent asks never answers it: an
 * agent does not allow itself.
 */
import {
  type ConsentAnswer,
  type RemoteConsent,
  RpcErrorCode,
} from "../../../../packages/remote-protocol/src";
import { isEachTimeChange, isTerminalChange } from "../../../shared/cli/ui";
import { isManagerWorkspace } from "../../../shared/manager/manager";
import type { CliServices, PendingConsent } from "../cli/context";
import { RpcFailure } from "./room";

/** What the user lets other devices control here (Settings › Remote). */
export interface ConsentControls {
  readonly chat: boolean;
  readonly terminal: boolean;
}

/** Whether `deviceId` may answer `pending`, and why not when not. */
function refusalFor(
  pending: PendingConsent,
  deviceId: string,
  controls: ConsentControls,
): string | null {
  const { request } = pending;
  if (request.fromDeviceId === deviceId) {
    return "the prompt is about this device's own agent; the user answers it at the other computer";
  }
  if (!controls.chat) return "control of the chats is off there (Settings › Remote)";
  if (isTerminalChange(request.change) && !controls.terminal) {
    return "control of the terminals is off there (Settings › Remote)";
  }
  return null;
}

/** The prompts waiting on the user, as the device `deviceId` is told them, oldest first. */
export async function remoteConsents(
  services: CliServices,
  deviceId: string,
  controls: ConsentControls,
  now = Date.now(),
): Promise<RemoteConsent[]> {
  const pending = services.consents.list();
  if (pending.length === 0) return [];
  // The asking tabs' titles, a workspace's tabs looked up once.
  const tabs = new Map<string, Promise<readonly { id: string; title: string }[]>>();
  const titleOf = async (workspaceId: string, tabId: string) => {
    let listed = tabs.get(workspaceId);
    if (!listed) {
      listed = services
        .ui("tabs.list", { workspaceId })
        .then((r) => r.tabs)
        .catch(() => []);
      tabs.set(workspaceId, listed);
    }
    return (await listed).find((t) => t.id === tabId)?.title;
  };
  const workspaces = services.listWorkspaces();
  return Promise.all(
    pending.map(async (p): Promise<RemoteConsent> => {
      const { request } = p;
      const remote = request.fromDevice !== undefined && request.fromDeviceId !== undefined;
      const manager = !remote && isManagerWorkspace(request.fromWorkspaceId);
      const workspaceName = remote
        ? undefined
        : workspaces.find((w) => w.id === request.fromWorkspaceId)?.name;
      const name =
        request.fromName ??
        (remote ? undefined : await titleOf(request.fromWorkspaceId, request.fromTabId));
      const { kind, detail, body } = request.change;
      return {
        id: p.id,
        at: p.at,
        expiresAt: p.expiresAt,
        expiresInMs: Math.max(0, Math.round(p.expiresAt - now)),
        from: {
          ...(remote
            ? { device: { id: request.fromDeviceId as string, name: request.fromDevice as string } }
            : {}),
          ...(manager ? { manager: true } : {}),
          workspaceId: request.fromWorkspaceId,
          ...(workspaceName !== undefined ? { workspaceName } : {}),
          tabId: request.fromTabId,
          ...(name !== undefined ? { name } : {}),
        },
        workspaceId: request.toWorkspaceId,
        change: {
          kind,
          ...(detail !== undefined ? { detail } : {}),
          ...(body !== undefined ? { body } : {}),
        },
        eachTime: isEachTimeChange(kind),
        answerable: refusalFor(p, deviceId, controls) === null,
      };
    }),
  );
}

/**
 * Answers the prompt `id` from the device `deviceId` (named `deviceName`):
 * NotFound once it no longer waits, Forbidden when that device may not
 * answer it, or not so ("session" to what is asked about each time).
 */
export async function answerConsent(
  services: CliServices,
  device: { readonly id: string; readonly name: string },
  controls: ConsentControls,
  { id, answer }: { id: string; answer: ConsentAnswer },
): Promise<Record<string, never>> {
  const pending = services.consents.list().find((p) => p.id === id);
  if (!pending) {
    throw new RpcFailure(RpcErrorCode.NotFound, "no such prompt: answered, or run out, since");
  }
  const refusal = refusalFor(pending, device.id, controls);
  if (refusal) throw new RpcFailure(RpcErrorCode.Forbidden, refusal);
  if (answer === "session" && isEachTimeChange(pending.request.change.kind)) {
    throw new RpcFailure(
      RpcErrorCode.Forbidden,
      "it is asked about each time: allow it once, or turn it down",
    );
  }
  if (!(await services.consents.answer(id, answer, device.name))) {
    throw new RpcFailure(RpcErrorCode.NotFound, "no such prompt: answered, or run out, since");
  }
  return {};
}
