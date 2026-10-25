/**
 * MCP server instructions, sent to the client at initialization (Claude reads them for every
 * connection, without any skill installed). Single source: skill/SKILL.md, without its front matter;
 * the build copies it to dist/skill/ so the container has it.
 */
import fs from "node:fs";

const candidates = [
  new URL("./skill/SKILL.md", import.meta.url), // dist/ (build output, container)
  new URL("../skill/SKILL.md", import.meta.url), // src/ (tsx, tests)
];

const HEADER =
  "bpmn-collab: collaborative BPMN 2.0 modeling with a human who edits the same diagrams in a web canvas. " +
  "Follow this guide when you use the tools of this server.\n\n";

function load() {
  for (const url of candidates) {
    try {
      const text = fs.readFileSync(url, "utf8");
      return HEADER + text.replace(/^---[\s\S]*?\n---\s*\n/, "").trim();
    } catch {
      /* try the next location */
    }
  }
  throw new Error("skill/SKILL.md not found: the server instructions cannot be built");
}

export const instructions = load();
