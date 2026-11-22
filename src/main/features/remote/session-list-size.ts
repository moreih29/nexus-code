import type {
  RpcRequest,
  RpcResult,
  SessionsUpdate,
} from "../../../../packages/remote-protocol/src";
import { createLogger } from "../../../shared/log/main";
import { fitsInFrame } from "./room";

const log = createLogger("remote-session-list");
const levels = ["full", "references", "none"] as const;
export type OpenerDetail = (typeof levels)[number];
type SessionsList = RpcResult<"sessions.list">;
const warned = new Set<OpenerDetail>();

function withOpenerDetail<T extends SessionsList>(list: T, detail: OpenerDetail): T {
  if (detail === "full") return list;
  return {
    ...list,
    sessions: list.sessions.map((session) => {
      if (!session.openedBy) return session;
      const { openedBy, ...rest } = session;
      if (detail === "none") return rest;
      const { name: _name, device, ...reference } = openedBy;
      return {
        ...rest,
        openedBy: { ...reference, ...(device ? { device: { id: device.id } } : {}) },
      };
    }),
  };
}

/** Choose the richest listing for the actual outbound message, up to the watch's current detail. */
function fitListing<T extends SessionsList>(
  list: T,
  fits: (candidate: T) => boolean,
  detail: OpenerDetail,
): { list: T; detail: OpenerDetail } | undefined {
  for (const level of levels.slice(levels.indexOf(detail))) {
    const candidate = withOpenerDetail(list, level);
    if (!fits(candidate)) continue;
    if (level !== detail && !warned.has(level)) {
      warned.add(level);
      log.warn(
        level === "references"
          ? "Omitted session opener names to fit the remote message limit"
          : "Omitted session opener references to fit the remote message limit",
      );
    }
    return { list: candidate, detail: level };
  }
  return undefined;
}

export function fitSessionReply<T extends SessionsList>(list: T, id: RpcRequest["id"]) {
  return fitListing(list, (result) => fitsInFrame({ jsonrpc: "2.0", id, result }), "full");
}

export function fitSessionUpdate(update: SessionsUpdate, detail: OpenerDetail) {
  return fitListing(
    update,
    (params) => fitsInFrame({ jsonrpc: "2.0", method: "sessions.update", params }),
    detail,
  );
}
