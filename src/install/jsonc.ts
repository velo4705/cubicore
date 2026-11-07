/**
 * A string-aware JSONC reader.
 *
 * OpenCode reads opencode.jsonc — JSON with line comments, block comments,
 * and trailing commas. If the founder's existing config uses them, a plain
 * JSON.parse throws and we would either corrupt the file or refuse to
 * install. Instead we strip comments and trailing commas with a scanner
 * that understands strings (so `https://…` inside a string survives), then
 * parse as strict JSON.
 */

type State = "code" | "string" | "linecomment" | "blockcomment";

const CODE: State = "code";
const STRING: State = "string";
const LINE_COMMENT: State = "linecomment";
const BLOCK_COMMENT: State = "blockcomment";

/** Remove comments and trailing commas; returns strict JSON text. */
export function stripJsonc(input: string): string {
  let state: State = CODE;
  let output = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    const next = i + 1 < input.length ? (input[i + 1] as string) : "";

    if (state === STRING) {
      output += ch;
      if (ch === "\\" && i + 1 < input.length) {
        output += input[i + 1] as string;
        i += 2;
        continue;
      }
      if (ch === '"') state = CODE;
      i += 1;
      continue;
    }

    if (state === LINE_COMMENT) {
      if (ch === "\n") {
        output += ch;
        state = CODE;
      }
      i += 1;
      continue;
    }

    if (state === BLOCK_COMMENT) {
      if (ch === "*" && next === "/") {
        state = CODE;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    // CODE
    if (ch === '"') {
      output += ch;
      state = STRING;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      state = LINE_COMMENT;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = BLOCK_COMMENT;
      i += 2;
      continue;
    }
    output += ch;
    i += 1;
  }

  // Trailing commas: a comma whose next significant token is } or ].
  // Scan the comment-free text, string-aware, and drop those commas.
  let result = "";
  state = CODE;
  i = 0;
  while (i < output.length) {
    const ch = output[i] as string;
    if (state === STRING) {
      result += ch;
      if (ch === "\\" && i + 1 < output.length) {
        result += output[i + 1] as string;
        i += 2;
        continue;
      }
      if (ch === '"') state = CODE;
      i += 1;
      continue;
    }
    if (ch === '"') {
      result += ch;
      state = STRING;
      i += 1;
      continue;
    }
    if (ch === ",") {
      // Look ahead past whitespace for a closing brace/bracket.
      let j = i + 1;
      while (j < output.length && /\s/.test(output[j] as string)) j += 1;
      const ahead = output[j] as string | undefined;
      if (ahead === "}" || ahead === "]") {
        i += 1; // drop the comma
        continue;
      }
    }
    result += ch;
    i += 1;
  }
  return result;
}

/** Parse JSONC text into a value; throws SyntaxError on garbage. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}
