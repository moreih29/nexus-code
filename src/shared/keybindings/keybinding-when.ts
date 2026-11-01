/**
 * VSCode-style `when` expressions for keybindings.
 *
 * The grammar is intentionally a small subset of VSCode's
 * `ContextKeyExpr` — we only need what our shortcut declarations
 * actually use right now:
 *
 *     expr   := or
 *     or     := and ('||' and)*
 *     and    := unary ('&&' unary)*
 *     unary  := '!' unary | atom
 *     atom   := identifier | '(' expr ')'
 *
 * Identifiers are bare context-key names (`editorFocus`, `inputFocus`,
 * `fileTreeFocus`, `terminalFocus`, …). Equality checks (`view ==
 * 'explorer'`), regex match, and the `in` operator are intentionally
 * left out; add them only when a real binding needs them.
 *
 * The module is pure and runtime-agnostic — it never touches the DOM.
 * Evaluators inject a `(name) => boolean` getter that knows how to
 * resolve a key against the current event/document. That separation
 * keeps `parseWhen` testable without a renderer environment and lets
 * the parser live in `shared/` next to the binding declarations.
 */

export type WhenExpr =
  | { kind: "key"; name: string }
  | { kind: "not"; expr: WhenExpr }
  | { kind: "and"; left: WhenExpr; right: WhenExpr }
  | { kind: "or"; left: WhenExpr; right: WhenExpr };

/**
 * Parse a `when` string into an AST. Whitespace is insignificant.
 * Throws on malformed input — declarations live in source, so a parse
 * error is a programming bug we want to catch loudly at module load.
 */
export function parseWhen(input: string): WhenExpr {
  const tokens = tokenize(input);
  const cursor = { i: 0 };
  const expr = parseOr(tokens, cursor);
  if (cursor.i < tokens.length) {
    throw new Error(`when: unexpected token "${tokens[cursor.i]}" in ${JSON.stringify(input)}`);
  }
  return expr;
}

/**
 * Evaluate a parsed expression. `getter` returns the truth-value for
 * a context-key name. Unknown keys should resolve to `false` (caller's
 * choice) — the evaluator itself does not interpret missing keys.
 */
export function evaluateWhen(expr: WhenExpr, getter: (name: string) => boolean): boolean {
  switch (expr.kind) {
    case "key":
      return getter(expr.name);
    case "not":
      return !evaluateWhen(expr.expr, getter);
    case "and":
      return evaluateWhen(expr.left, getter) && evaluateWhen(expr.right, getter);
    case "or":
      return evaluateWhen(expr.left, getter) || evaluateWhen(expr.right, getter);
  }
}

/** The context-key names `expr` reads, in order, repeats included. */
export function whenKeys(expr: WhenExpr): string[] {
  switch (expr.kind) {
    case "key":
      return [expr.name];
    case "not":
      return whenKeys(expr.expr);
    default:
      return [...whenKeys(expr.left), ...whenKeys(expr.right)];
  }
}

/** The context keys that name the platform the app runs on. */
export const PLATFORM_KEYS: ReadonlySet<string> = new Set(["isMac", "isLinux", "isWindows"]);

/**
 * Whether `when` reads nothing but the platform (`isLinux`, `!isMac`,
 * `isMac || isWindows`): a declaration that exists for some platforms only,
 * not one scoped to a surface or a focus.
 */
export function isPlatformOnlyWhen(when: string): boolean {
  return whenKeys(parseWhen(when)).every((key) => PLATFORM_KEYS.has(key));
}

// ---------------------------------------------------------------------------
// Tokenizer + recursive-descent parser
// ---------------------------------------------------------------------------

type Token = string;

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if (c === "(" || c === ")" || c === "!") {
      out.push(c);
      i++;
      continue;
    }
    if (c === "&" && input[i + 1] === "&") {
      out.push("&&");
      i += 2;
      continue;
    }
    if (c === "|" && input[i + 1] === "|") {
      out.push("||");
      i += 2;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < input.length && isIdentRest(input[j])) j++;
      out.push(input.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`when: unexpected character "${c}" in ${JSON.stringify(input)}`);
  }
  return out;
}

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}

function isIdentRest(c: string): boolean {
  return /[A-Za-z0-9_.]/.test(c);
}

function parseOr(tokens: Token[], cur: { i: number }): WhenExpr {
  let left = parseAnd(tokens, cur);
  while (tokens[cur.i] === "||") {
    cur.i++;
    const right = parseAnd(tokens, cur);
    left = { kind: "or", left, right };
  }
  return left;
}

function parseAnd(tokens: Token[], cur: { i: number }): WhenExpr {
  let left = parseUnary(tokens, cur);
  while (tokens[cur.i] === "&&") {
    cur.i++;
    const right = parseUnary(tokens, cur);
    left = { kind: "and", left, right };
  }
  return left;
}

function parseUnary(tokens: Token[], cur: { i: number }): WhenExpr {
  if (tokens[cur.i] === "!") {
    cur.i++;
    return { kind: "not", expr: parseUnary(tokens, cur) };
  }
  return parseAtom(tokens, cur);
}

function parseAtom(tokens: Token[], cur: { i: number }): WhenExpr {
  const tok = tokens[cur.i];
  if (tok === undefined) throw new Error("when: unexpected end of expression");
  if (tok === "(") {
    cur.i++;
    const inner = parseOr(tokens, cur);
    if (tokens[cur.i] !== ")") throw new Error("when: missing closing parenthesis");
    cur.i++;
    return inner;
  }
  if (tok === ")" || tok === "&&" || tok === "||" || tok === "!") {
    throw new Error(`when: unexpected token "${tok}"`);
  }
  cur.i++;
  return { kind: "key", name: tok };
}
