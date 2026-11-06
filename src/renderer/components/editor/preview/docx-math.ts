// docx-preview draws the text of a Word equation as MathML string literals
// (<ms>), each run one upright literal set in Cambria Math, a font macOS
// and Linux do not have, and the scripts of a subscript sit apart from
// what follows. Word sets an equation's letters in italic, its numbers
// upright and its signs spaced as operators. The literals are changed here
// to the letters, numbers and operators they hold, which the browser lays
// out as Word does.

const MATHML = "http://www.w3.org/1998/Math/MathML";

export interface MathToken {
  tag: "mi" | "mn" | "mo" | "mtext";
  text: string;
  /** A letter Word sets upright, as a capital Greek one. */
  upright?: boolean;
}

/**
 * A number; a letter Word sets in italic, with its marks; a run of other
 * letters, as Hangul, which stay text; a space; or a sign.
 */
const TOKEN =
  /(\p{Nd}+(?:\.\p{Nd}+)?)|([\p{Script=Latin}\p{Script=Greek}]\p{M}*)|((?:(?![\p{Script=Latin}\p{Script=Greek}])\p{L}\p{M}*)+)|(\s+)|([\s\S])/gu;

/**
 * An equation run's text as MathML tokens. A function's name, as sin, is
 * one upright identifier; anything else is a token per letter, number and
 * sign, the spaces between them left to the operators.
 */
export function mathTokensOf(text: string, name = false): MathToken[] {
  if (name) {
    const trimmed = text.trim();
    return trimmed ? [{ tag: "mi", text: trimmed }] : [];
  }
  const tokens: MathToken[] = [];
  for (const [, number, letter, other, , sign] of text.matchAll(TOKEN)) {
    if (number) tokens.push({ tag: "mn", text: number });
    else if (letter)
      tokens.push(
        /\p{Script=Greek}/u.test(letter) && /\p{Lu}/u.test(letter)
          ? { tag: "mi", text: letter, upright: true }
          : { tag: "mi", text: letter },
      );
    else if (other) tokens.push({ tag: "mtext", text: other });
    else if (sign) tokens.push({ tag: "mo", text: sign === "-" ? "\u2212" : sign });
  }
  return tokens;
}

/** MathML's token elements, which hold text rather than other elements. */
const TOKEN_TAGS = ["mi", "mn", "mo", "ms", "mtext"];

/**
 * MathML's elements that lay their children out as one row. A run's tokens
 * go into such a row as they are. A sign's spacing depends on whether it is
 * first, last or between in its row, and Word spaces a run's signs by where
 * they stand in the whole equation. So a run of its own would set the minus
 * of `x² − 2x`, which starts the run after the script, as a unary minus.
 * A script, a fraction or a root takes each part as one child, so a run
 * there stays one row.
 */
const ROW_TAGS = new Set([
  "math",
  "mrow",
  "mstyle",
  "mtd",
  "msqrt",
  "mpadded",
  "mphantom",
  "menclose",
  "merror",
]);

/** Whether an element of this name lays its children out as one row (see ROW_TAGS). */
export function isMathRow(localName: string | undefined): boolean {
  return localName !== undefined && ROW_TAGS.has(localName);
}

/**
 * Changes a drawn document's equation literals to MathML tokens, in the row
 * the literal stood in (see ROW_TAGS). A literal inside a literal is a
 * function's name. A token element left holding elements, as the one around
 * a subscript's literal, becomes a row.
 */
export function wordMathTokens(body: ParentNode): void {
  const literals = Array.from(body.querySelectorAll("ms")).filter(
    (literal) => literal.children.length === 0,
  );
  for (const literal of literals) {
    const doc = literal.ownerDocument;
    const name = literal.parentElement?.localName === "ms";
    const tokens = mathTokensOf(literal.textContent ?? "", name).map(({ tag, text, upright }) => {
      const element = doc.createElementNS(MATHML, tag);
      element.textContent = text;
      if (upright) element.setAttribute("mathvariant", "normal");
      // Word draws a run's signs at the text's size. Only a delimiter, which
      // docx-preview draws as operators of its own, grows with what it holds.
      if (tag === "mo") element.setAttribute("stretchy", "false");
      return element;
    });
    // Word sets a thin space between a function's name and its argument.
    if (name && tokens.length > 0) {
      const space = doc.createElementNS(MATHML, "mspace");
      space.setAttribute("width", "0.1667em");
      tokens.push(space);
    }
    if (tokens.length === 1 && tokens[0]) {
      literal.replaceWith(tokens[0]);
    } else if (isMathRow(literal.parentElement?.localName)) {
      literal.replaceWith(...tokens);
    } else {
      const row = doc.createElementNS(MATHML, "mrow");
      row.append(...tokens);
      literal.replaceWith(row);
    }
  }
  for (const token of Array.from(body.querySelectorAll(TOKEN_TAGS.join(",")))) {
    if (token.children.length === 0) continue;
    const row = token.ownerDocument.createElementNS(MATHML, "mrow");
    row.append(...Array.from(token.childNodes));
    token.replaceWith(row);
  }
}
