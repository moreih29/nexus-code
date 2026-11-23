const MATHML = "http://www.w3.org/1998/Math/MathML";

export interface MathToken {
  tag: "mi" | "mn" | "mo" | "mtext";
  text: string;
  upright?: boolean;
}

const TOKEN =
  /(\p{Nd}+(?:\.\p{Nd}+)?)|([\p{Script=Latin}\p{Script=Greek}]\p{M}*)|((?:(?![\p{Script=Latin}\p{Script=Greek}])\p{L}\p{M}*)+)|(\s+)|([\s\S])/gu;

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

const TOKEN_TAGS = ["mi", "mn", "mo", "ms", "mtext"];

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

export function isMathRow(localName: string | undefined): boolean {
  return localName !== undefined && ROW_TAGS.has(localName);
}

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
      if (tag === "mo") element.setAttribute("stretchy", "false");
      return element;
    });
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
