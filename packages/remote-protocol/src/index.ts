/**
 * NexusCode's remote protocol, in two layers:
 * - ./relay: the frames between a device and its account's room on the
 *   relay, which the relay reads and routes;
 * - ./sealed, ./rpc, ./view: what a sealed frame carries between two
 *   devices of the account, which only they can open.
 */
export * from "./relay";
export * from "./rpc";
export * from "./sealed";
export * from "./view";
