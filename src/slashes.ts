/**
 * Slash trimming in one linear pass.
 *
 * `replace(/\/+$/, "")` and `replace(/^\/+|\/+$/g, "")` backtrack polynomially
 * on a long run of slashes that is not at the end of the string (CodeQL
 * js/polynomial-redos), and every caller here trims a URL or a path that came
 * from outside the SDK. A loop does the same thing in linear time.
 *
 * Internal: not exported from the package root.
 */

/** `text` without the slashes at its end. */
export function trimTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x2f) end -= 1;
  return text.slice(0, end);
}

/** `text` without the slashes at either end. */
export function trimSlashes(text: string): string {
  let start = 0;
  const trimmed = trimTrailingSlashes(text);
  while (start < trimmed.length && trimmed.charCodeAt(start) === 0x2f) start += 1;
  return trimmed.slice(start);
}
