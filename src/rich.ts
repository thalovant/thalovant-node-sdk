export interface ThalovantDisplayItem {
  kind: string;
  text?: string;
  data?: unknown;
  title?: string;
  payload?: string;
  url?: string;
  silent?: boolean;
}

/**
 * Remove markup: tags, comments and processing instructions. Only real markup
 * goes, so "5 < 6 and 7 > 3" survives whole; entities are left as they are.
 *
 * A tag is `<` or `</` immediately followed by an ASCII letter, then
 * everything up to the next `>` that is not inside a quoted attribute value.
 * A comment is `<!--` to `-->`, a processing instruction `<?` to `?>`. Any
 * other `<` is text, and so is a construct that never closes.
 */
export function stripSsml(text: string): string {
  const lastClose = text.lastIndexOf(">");
  let out = "";
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf("<", index);
    if (at < 0 || at > lastClose) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, at);
    const end = markupEnd(text, at);
    if (end < 0) {
      out += "<";
      index = at + 1;
    } else {
      index = end;
    }
  }
  return out;
}

/** Where the markup opening at `at` ends (just past it), or -1 when `<` there is text. */
function markupEnd(text: string, at: number): number {
  if (text.startsWith("<!--", at)) {
    const close = text.indexOf("-->", at + 4);
    return close < 0 ? -1 : close + 3;
  }
  if (text.startsWith("<?", at)) {
    const close = text.indexOf("?>", at + 2);
    return close < 0 ? -1 : close + 2;
  }
  const name = text[at + 1] === "/" ? at + 2 : at + 1;
  if (!/[A-Za-z]/.test(text[name] ?? "")) return -1;
  let quote = "";
  for (let index = name + 1; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index + 1;
    }
  }
  return -1;
}

export function richMediaFromData(data: Record<string, unknown>): Record<string, unknown> {
  const media = asRecord(parseJson(data.rich_media_data ?? data.rich_media ?? data.display));
  if (Object.keys(media).length > 0) return media;
  const direct: Record<string, unknown> = {};
  for (const key of ["table", "attachment", "attachments", "quick_replies", "buttons", "image", "images"]) {
    if (key in data) direct[key] = data[key];
  }
  return direct;
}

export function displayItemsFromEventData(
  data: Record<string, unknown>,
  options: { eventName?: string; maxTextChars?: number } = {},
): ThalovantDisplayItem[] {
  const items: ThalovantDisplayItem[] = [];
  const text = textFromData(data);
  if (text) {
    for (const chunk of chunks(stripSsml(text), options.maxTextChars)) {
      items.push({ kind: "text", text: chunk, silent: Boolean(data.silent) || options.eventName === "write" });
    }
  }
  const media = richMediaFromData(data);
  const table = parseJson(media.table);
  if (table !== undefined) items.push({ kind: "table", data: table });
  for (const attachment of attachments(media)) {
    const payload = asRecord(attachment.payload);
    const url = stringValue(payload.src ?? payload.url ?? attachment.src ?? attachment.url);
    const type = stringValue(attachment.type) ?? "attachment";
    items.push({ kind: type === "image" ? "image" : "attachment", data: attachment, title: stringValue(attachment.title), url });
  }
  const choices = asArray(parseJson(media.quick_replies ?? media.buttons)).map(choice).filter(Boolean) as Record<string, unknown>[];
  if (choices.length) items.push({ kind: "choices", data: choices });
  for (const image of asArray(parseJson(media.image ?? media.images))) {
    const url = typeof image === "object" && image ? stringValue((image as Record<string, unknown>).src ?? (image as Record<string, unknown>).url) : stringValue(image);
    if (url) items.push({ kind: "image", url, data: image });
  }
  return items;
}

function textFromData(data: Record<string, unknown>): string {
  const direct = data.utterance ?? data.text;
  if (typeof direct === "string") return direct;
  if (typeof data.utterances === "string") return data.utterances;
  if (Array.isArray(data.utterances)) return data.utterances.filter((item): item is string => typeof item === "string").join(" ");
  return "";
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function attachments(media: Record<string, unknown>): Record<string, unknown>[] {
  const raw = media.attachments ?? media.attachment;
  if (Array.isArray(raw)) return raw.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item));
  const one = asRecord(raw);
  return Object.keys(one).length ? [one] : [];
}

function choice(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") return { title: value, payload: value, data: value };
  const raw = asRecord(value);
  if (!Object.keys(raw).length) return undefined;
  const title = stringValue(raw.title ?? raw.label ?? raw.text) ?? "";
  const payload = stringValue(raw.payload ?? raw.value ?? title) ?? "";
  return { title, payload, data: raw };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stringValue(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function chunks(text: string, maxChars?: number): string[] {
  if (!maxChars || text.length <= maxChars) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let index = remaining.lastIndexOf(" ", maxChars);
    if (index <= 0) index = maxChars;
    out.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }
  if (remaining) out.push(remaining);
  return out;
}
