/**
 * What to call a hub on a screen somebody is reading.
 *
 * Every control-plane read in this SDK returns raw JSON, so each caller picks
 * its own fields -- and on 2026-09-15 a phone offered somebody a list of rooms
 * called "ops-copilot", "daily-desk", "news-stream". Those are slugs. The app
 * was not careless: it read `name` and preferred it over `slug`, and on that
 * deployment `name` *holds* the slug. The name a person was shown when the hub
 * was made lives in `spec.catalog.title`.
 *
 * One place to get that wrong is better than one per app.
 */

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The readable name of a hub, never a slug when anything better exists. */
export function hubDisplayName(hub: Record<string, unknown>): string {
  const catalog = record(record(hub.spec)?.catalog);
  const title = text(catalog?.title);
  if (title) return title;

  const name = text(hub.name);
  const slug = text(hub.slug);
  // A name that is exactly the slug is the slug.
  if (name && name !== slug) return name;

  const identifier = name ?? slug;
  if (!identifier) return "A Thalovant hub";
  const words = identifier.replace(/_/g, "-").split("-").filter(Boolean);
  const readable = words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
  return readable || "A Thalovant hub";
}
