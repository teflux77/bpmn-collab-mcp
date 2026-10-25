/** File names for exported diagrams; no Node dependency, shared with the canvas (ui/). */

/** "Commande client & retours" -> "commande-client-retours" (ASCII, safe in a file name). */
export function slug(name: string) {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining accents left by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "diagram";
}

export const exportFileName = (name: string, version: number, ext = "bpmn") => `${slug(name)}-v${version}.${ext}`;

