import { reportError } from "../recent-errors/report";
import type { ResultInfo } from "./model";

export function failedTurn(result: ResultInfo | undefined): boolean {
  if (!result) return false;
  return result.outcome !== undefined ? result.outcome === "error" : result.isError;
}

export function reportTurnError(agent: "claude" | "codex", result: ResultInfo | undefined): void {
  if (!result || !failedTurn(result)) return;
  reportError("agent", [agent, result.failure?.kind ?? result.subtype], result.failure?.status);
}
