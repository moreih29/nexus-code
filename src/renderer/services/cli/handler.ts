/** What answers one of main's CLI requests. */
import type { CliUiOp, CliUiOps } from "../../../shared/cli/ui";

export type CliUiHandler<K extends CliUiOp> = (
  args: CliUiOps[K]["args"],
) => Promise<CliUiOps[K]["result"]>;

/** A failure the CLI shows the agent as is. */
export class UiRequestError extends Error {}
