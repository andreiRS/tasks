/**
 * Hand-rolled, fence-aware, case-insensitive parser for the `## Acceptance
 * Criteria` section of a task body. Implements the PRD's "Acceptance Criteria
 * parsing rules" exactly:
 *
 *   1. Heading match is case-insensitive on the literal string
 *      `acceptance criteria`, preceded by exactly `## ` at start of line.
 *   2. The section extends from the line AFTER the heading to the line BEFORE
 *      the next `##` heading of any level (any line matching `^##+ `) or EOF.
 *   3. Lines inside fenced code blocks (delimited by ``` or ~~~) are ignored
 *      for heading matching. A fake heading inside a code fence does not
 *      start or end the section.
 *   4. Extracted value is trimmed of leading/trailing blank lines; internal
 *      formatting is preserved verbatim.
 *   5. If the section is absent, returns the empty string "".
 *
 * Deliberately a small line-scanner state machine tracking a single
 * "inside fence" boolean — not a markdown AST.
 */
export function parseAcceptanceCriteria(body: string): string {
  if (!body) return "";
  const lines = body.split("\n");
  let insideFence = false;
  let fenceMarker: string | null = null; // "```" or "~~~"
  let inSection = false;
  const collected: string[] = [];

  for (const line of lines) {
    // Fence open/close: only the marker matching the currently-open fence
    // closes it. A line beginning with ``` or ~~~ toggles state.
    const fenceMatch = /^(```|~~~)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!insideFence) {
        insideFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        insideFence = false;
        fenceMarker = null;
      }
      // Inside-section fence lines are body content; collect them.
      if (inSection) collected.push(line);
      continue;
    }

    if (insideFence) {
      if (inSection) collected.push(line);
      continue;
    }

    // Outside any fence: check for headings.
    if (inSection) {
      // Any `##+ ` heading terminates the section.
      if (/^##+ /.test(line)) {
        break;
      }
      collected.push(line);
      continue;
    }

    // Not yet in the section: look for the start heading.
    // Match exactly `## ` followed by `acceptance criteria` (case-insensitive),
    // trimmed of trailing whitespace.
    if (/^## /.test(line)) {
      const rest = line.slice(3).trim();
      if (rest.toLowerCase() === "acceptance criteria") {
        inSection = true;
      }
    }
  }

  // Trim leading/trailing blank lines; preserve internal formatting verbatim.
  let start = 0;
  let end = collected.length;
  while (start < end && collected[start].trim() === "") start++;
  while (end > start && collected[end - 1].trim() === "") end--;
  return collected.slice(start, end).join("\n");
}
