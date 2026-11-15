/**
 * The one-time ticket a socket to the server signs in with (/relay, /voice),
 * asked with the relay version this app speaks: a server that no longer
 * takes it says so here, where its answer can be read, and the app must be
 * updated (OutdatedError).
 */
import { z } from "zod";
import { RELAY_VERSION, UNSUPPORTED_VERSION } from "../../../../packages/remote-protocol/src";
import type { RemoteAccount } from "./account";
import { OutdatedError, ServerError } from "./errors";

/** POST /relay/ticket's answer: a short-lived ticket a socket signs in with. */
export const TicketSchema = z.object({ ticket: z.string().min(1) });

/** A ticket, with `body` (a voice session's names); OutdatedError for an app too old. */
export async function askTicket(
  account: Pick<RemoteAccount, "request">,
  body?: unknown,
): Promise<string> {
  try {
    const answer = await account.request("POST", `/relay/ticket?v=${RELAY_VERSION}`, body);
    return TicketSchema.parse(answer).ticket;
  } catch (error) {
    if (
      error instanceof ServerError &&
      error.status === 400 &&
      error.code === UNSUPPORTED_VERSION
    ) {
      throw new OutdatedError();
    }
    throw error;
  }
}
