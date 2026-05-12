export interface SshConfigHost {
  alias: string;
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

interface SshDirective {
  keyword: string;
  args: string[];
}

/**
 * Parses top-level Host blocks from ssh config text into concrete aliases.
 */
export function parseSshConfig(text: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = [];
  let currentHosts: SshConfigHost[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const directive = parseDirective(rawLine);
    if (!directive) {
      continue;
    }

    const keyword = directive.keyword.toLowerCase();
    if (keyword === "host") {
      currentHosts = directive.args.filter(isConcreteHostAlias).map((alias) => ({ alias }));
      hosts.push(...currentHosts);
      continue;
    }

    if (keyword === "match") {
      currentHosts = [];
      continue;
    }

    if (keyword === "include" || currentHosts.length === 0 || directive.args.length === 0) {
      continue;
    }

    applyHostDirective(currentHosts, keyword, directive.args[0]);
  }

  return hosts;
}

/**
 * Parses a config line into a case-insensitive keyword and shell-like args.
 */
function parseDirective(rawLine: string): SshDirective | null {
  const line = rawLine.trimStart();
  if (line.length === 0 || line.startsWith("#")) {
    return null;
  }

  let keywordEnd = 0;
  while (
    keywordEnd < line.length &&
    !isWhitespace(line[keywordEnd]) &&
    line[keywordEnd] !== "=" &&
    line[keywordEnd] !== "#"
  ) {
    keywordEnd += 1;
  }
  if (keywordEnd === 0) {
    return null;
  }

  let restStart = keywordEnd;
  while (restStart < line.length && isWhitespace(line[restStart])) {
    restStart += 1;
  }
  if (line[restStart] === "=") {
    restStart += 1;
    while (restStart < line.length && isWhitespace(line[restStart])) {
      restStart += 1;
    }
  }

  return {
    keyword: line.slice(0, keywordEnd),
    args: tokenizeArgs(line.slice(restStart)),
  };
}

/**
 * Splits directive arguments while respecting simple single and double quotes.
 */
function tokenizeArgs(text: string): string[] {
  const args: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && char === "\\" && index + 1 < text.length) {
        index += 1;
        token += text[index];
        continue;
      }
      token += char;
      continue;
    }

    if (char === "#") {
      break;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (isWhitespace(char)) {
      if (token.length > 0) {
        args.push(token);
        token = "";
      }
      continue;
    }

    token += char;
  }

  if (token.length > 0) {
    args.push(token);
  }

  return args;
}

/**
 * Applies supported per-host options to every concrete alias in a Host block.
 */
function applyHostDirective(hosts: SshConfigHost[], keyword: string, value: string): void {
  if (keyword === "hostname") {
    for (const host of hosts) {
      host.host = value;
    }
    return;
  }

  if (keyword === "user") {
    for (const host of hosts) {
      host.user = value;
    }
    return;
  }

  if (keyword === "port") {
    const port = parsePort(value);
    if (port === undefined) {
      return;
    }
    for (const host of hosts) {
      host.port = port;
    }
    return;
  }

  if (keyword === "identityfile") {
    for (const host of hosts) {
      host.identityFile = value;
    }
  }
}

/**
 * Returns true for Host aliases that represent a single named target.
 */
function isConcreteHostAlias(alias: string): boolean {
  return alias.length > 0 && !alias.startsWith("!") && !alias.includes("*") && !alias.includes("?");
}

/**
 * Parses valid TCP port values used by ssh config Port directives.
 */
function parsePort(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const port = Number(value);
  return port > 0 && port <= 65_535 ? port : undefined;
}

/**
 * Checks ASCII whitespace used as config token separators.
 */
function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}
