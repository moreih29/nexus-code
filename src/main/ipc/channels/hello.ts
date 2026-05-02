import { ipcContract } from "../../../shared/ipc-contract";
import { broadcast, register, validateArgs } from "../router";

const pingSchema = ipcContract.hello.call.ping.args;

register("hello", {
  call: {
    ping: (args: unknown) => {
      validateArgs(pingSchema, args);
      return "pong" as const;
    },
  },
  listen: {},
});

export function startTickBroadcast(): () => void {
  let count = 0;
  const interval = setInterval(() => {
    count += 1;
    broadcast("hello", "tick", count);
    if (count >= 5) {
      clearInterval(interval);
    }
  }, 1000);
  return () => clearInterval(interval);
}
