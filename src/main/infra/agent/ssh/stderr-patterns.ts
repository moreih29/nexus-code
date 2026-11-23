import type { SshErrorCode } from "../../../../shared/ssh/errors";

const AUTH_FAILED_PATTERNS = [
  /permission denied \(/i,
  /permission denied, please try again/i,
  /authentication failed/i,
  /too many authentication failures/i,
  /host key verification failed/i,
  /remote host identification has changed/i,
];

const CONNECT_FAILED_PATTERNS = [
  /connection refused/i,
  /connection timed out/i,
  /operation timed out/i,
  /no route to host/i,
  /network is unreachable/i,
  /could not resolve hostname/i,
  /name or service not known/i,
  /nodename nor servname provided/i,
  /temporary failure in name resolution/i,
  /connection closed by/i,
  /connection reset by/i,
  /kex_exchange_identification:.*connection closed/i,
  /banner exchange:.*connection/i,
];

const SERVER_SPAWN_FAILED_PATTERNS = [
  /\bcommand not found\b/i,
  /\b(?:bash|sh|zsh): .*: not found\b/i,
  /\b(?:bash|sh|zsh): .*: no such file or directory\b/i,
  /\bexec: .*: not found\b/i,
  /\bexec: .*: no such file or directory\b/i,
  /cannot execute: required file not found/i,
  /version `?GLIBC_[\d.]+'? not found/i,
  /error while loading shared libraries/i,
  /cannot execute binary file/i,
];

export function classifyStderrLine(line: string): SshErrorCode | null {
  if (AUTH_FAILED_PATTERNS.some((pattern) => pattern.test(line))) {
    return "ssh.auth-failed";
  }
  if (CONNECT_FAILED_PATTERNS.some((pattern) => pattern.test(line))) {
    return "ssh.connect-failed";
  }
  if (SERVER_SPAWN_FAILED_PATTERNS.some((pattern) => pattern.test(line))) {
    return "server.spawn-failed";
  }
  return null;
}
