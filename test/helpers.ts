import fs from "node:fs";

export const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** Apply literal string replacements to a fixture, failing loudly if one does not match. */
export function edit(xml: string, ...pairs: [string, string][]) {
  for (const [from, to] of pairs) {
    if (!xml.includes(from)) throw new Error(`edit(): "${from}" not found`);
    xml = xml.replace(from, to);
  }
  return xml;
}
