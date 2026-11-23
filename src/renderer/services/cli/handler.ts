import type { CliUiOp, CliUiOps } from "../../../shared/cli/ui";

export type CliUiHandler<K extends CliUiOp> = (
  args: CliUiOps[K]["args"],
) => Promise<CliUiOps[K]["result"]>;

export class UiRequestError extends Error {}
