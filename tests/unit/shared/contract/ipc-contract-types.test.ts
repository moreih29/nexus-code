import { type InferArgs, type InferReturn, ipcContract } from "../../../../src/shared/ipc-contract";

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
assertType<Equals<CreateArgs, { rootPath: string; name?: string | undefined }>>();

type CreateReturn = InferReturn<typeof ipcContract.workspace.call.create>;
assertType<CreateReturn extends { id: string; rootPath: string } ? true : false>();

// ---------------------------------------------------------------------------
// hello.call.ping
// ---------------------------------------------------------------------------

type PingReturn = InferReturn<typeof ipcContract.hello.call.ping>;
assertType<Equals<PingReturn, "pong">>();
