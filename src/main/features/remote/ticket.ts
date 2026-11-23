import { z } from "zod";
import { RELAY_VERSION, UNSUPPORTED_VERSION } from "../../../../packages/remote-protocol/src";
import type { RemoteAccount } from "./account";
import { OutdatedError, ServerError } from "./errors";

export const TicketSchema = z.object({ ticket: z.string().min(1) });

export async function askTicket(
  account: Pick<RemoteAccount, "request">,
  body?: unknown,
  signal?: AbortSignal,
): Promise<string> {
  try {
    signal?.throwIfAborted();
    const answer = await account.request(
      "POST",
      `/relay/ticket?v=${RELAY_VERSION}`,
      body,
      undefined,
      signal,
    );
    signal?.throwIfAborted();
    return TicketSchema.parse(answer).ticket;
  } catch (error) {
    signal?.throwIfAborted();
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
