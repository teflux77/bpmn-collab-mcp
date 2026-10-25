// Shared helpers for the deployment scripts (run on the developer's machine).
// Secrets come from the environment (.env.local loaded by `node --env-file-if-exists=.env.local`);
// they are never printed, logged or written anywhere.

export const APPLY = process.argv.includes("--apply");

// Names used in .env.local, with the earlier names accepted as fallbacks.
for (const [name, fallback] of [["VPS_IPV4", "VPS_IP"], ["MY_IP", "ADMIN_IP"]]) {
  if (!process.env[name]?.trim() && process.env[fallback]?.trim()) process.env[name] = process.env[fallback];
}

/** Returns the named variables or exits listing the missing ones (names only, never values). */
export function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]?.trim());
  if (missing.length) {
    console.error(`Missing in environment / .env.local: ${missing.join(", ")}`);
    process.exit(2);
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n].trim()]));
}

/** JSON over HTTPS with a bearer token; errors never include the token. */
export async function api(base, token, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, ok: res.ok, json };
}

export function fail(message, detail) {
  console.error(`✖ ${message}`);
  if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
  process.exit(1);
}

export const banner = () => console.log(APPLY ? "Mode: APPLY (changes will be made)" : "Mode: dry-run (nothing is changed; pass --apply to apply)");
