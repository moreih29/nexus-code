import type { InferArgs, InferReturn, ipcContract } from "../../../../src/shared/ipc/ipc-contract";
import type { WorkspaceLocation } from "../../../../src/shared/types/workspace";

// ---------------------------------------------------------------------------
// Compile-time type assertion helpers
// ---------------------------------------------------------------------------

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function assertType<_T extends true>(): void {}

// ---------------------------------------------------------------------------
// workspace.call.create
// ---------------------------------------------------------------------------

type CreateArgs = InferArgs<typeof ipcContract.workspace.call.create>;
assertType<
  Equals<
    CreateArgs,
    | { location: WorkspaceLocation; name?: string | undefined }
    | { rootPath: string; name?: string | undefined }
  >
>();

type CreateReturn = InferReturn<typeof ipcContract.workspace.call.create>;
assertType<
  CreateReturn extends { id: string; location: WorkspaceLocation; rootPath: string } ? true : false
>();

type ConnectionChangedArgs = InferArgs<typeof ipcContract.workspace.listen.connectionChanged>;
assertType<
  Equals<
    ConnectionChangedArgs,
    {
      workspaceId: string;
      status: "connecting" | "connected" | "reconnecting" | "error" | "disconnected";
    }
  >
>();

// ---------------------------------------------------------------------------
// lsp.call.didOpen
// ---------------------------------------------------------------------------

type DidOpenArgs = InferArgs<typeof ipcContract.lsp.call.didOpen>;
assertType<
  Equals<
    DidOpenArgs,
    {
      workspaceId: string;
      workspaceRoot: string;
      uri: string;
      languageId: string;
      version: number;
      text: string;
    }
  >
>();

// ---------------------------------------------------------------------------
// dialog.call.showOpenFile — exercises a literal-typed return shape so the
// inference helpers stay covered after the demo `hello` channel was retired.
// ---------------------------------------------------------------------------

type OpenFileReturn = InferReturn<typeof ipcContract.dialog.call.showOpenFile>;
assertType<Equals<OpenFileReturn, { canceled: boolean; filePaths: string[] }>>();
