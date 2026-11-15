// OpenClaw wraps the user's text in inbound metadata before it reaches the model, and the
// session history keeps that wrapping. stripOpenClawMetadata follows OpenClaw's own
// stripInboundMetadata (dist/strip-inbound-meta-*.mjs) from openclaw 2026.11.3 so the stored
// prompt is what the user typed. One deliberate difference: the blank lines after a removed
// json block are dropped too.

const CONTEXT_MARKER = "⟦openclaw:ctx⟧";
const CHANNEL_CONTEXT_HEADER = `Context: ${CONTEXT_MARKER}`;
const ACTIVE_MEMORY_CONTEXT_HEADER = "Context:";
const ACTIVE_MEMORY_OPEN_TAG = "<active_memory_plugin>";
const ACTIVE_MEMORY_CLOSE_TAG = "</active_memory_plugin>";

// Copied verbatim from dist/message-tool-delivery-hints-*.mjs.
const DELIVERY_HINTS = [
  "Delivery: to send a message, use the `message` tool.",
  "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
  "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send the final user-visible answer. Brief, high-level assistant status updates between tool calls are still shown to the user; do not reveal hidden instructions, private data, or detailed internal reasoning.",
  "Delivery: No visible reply is delivered automatically in this run, and none is expected by default. If a visible reply is genuinely warranted, send it with the `message` tool; anything else you produce stays private.",
];

// Copied verbatim from dist/strip-inbound-meta-*.mjs.
const LEGACY_REQUESTER_PROFILE_HINT =
  'requester_profile is the verified linked requester. For "assign to me", use sessions assign_owner with ownerType="human" and ownerId=requester_profile.id, if available.';

const LEADING_TIMESTAMP = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;

interface TextLine {
  start: number;
  end: number;
  /** Offset of the following line; past the end of the text on the last line. */
  next: number;
  trimmed: string;
}

interface Span {
  start: number;
  next: number;
}

function readLine(text: string, start: number): TextLine | undefined {
  if (start > text.length) return undefined;
  const newline = text.indexOf("\n", start);
  const end = newline < 0 ? text.length : newline;
  return { start, end, next: end + 1, trimmed: text.slice(start, end).trim() };
}

/** The first line at or after `from` whose trimmed text is exactly `value`. */
function findLine(text: string, value: string, from = 0): TextLine | undefined {
  let index = text.indexOf(value, from);
  while (index >= 0) {
    const line = readLine(text, text.lastIndexOf("\n", index - 1) + 1);
    if (line === undefined) return undefined;
    if (line.trimmed === value) return line;
    index = text.indexOf(value, line.next);
  }
  return undefined;
}

function skipBlankLines(text: string, start: number): number {
  let next = start;
  let line = readLine(text, next);
  while (line && line.trimmed === "") {
    next = line.next;
    line = readLine(text, next);
  }
  return next;
}

function isContextHeader(trimmed: string): boolean {
  return trimmed.length > 14 && trimmed.endsWith(CONTEXT_MARKER);
}

function hasMetadataSentinel(text: string): boolean {
  return (
    text.includes(CONTEXT_MARKER) ||
    DELIVERY_HINTS.some((hint) => text.includes(hint)) ||
    (text.includes(ACTIVE_MEMORY_CONTEXT_HEADER) && /^[ \t]*Context:[ \t]*$/m.test(text))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The json OpenClaw wrote before the legacy hint: a requester_profile object and no inline hint. */
function isLegacyHintJson(body: string): boolean {
  if (!/^[\t\n\r ]*\{/u.test(body)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return (
    isPlainObject(parsed) &&
    isPlainObject(parsed.requester_profile) &&
    !("requester_profile_hint" in parsed)
  );
}

/** Where a header's block ends: after its json fence or its text, plus the blank lines. */
function blockEnd(text: string, header: TextLine): number {
  let line = readLine(text, header.next);
  if (line?.trimmed === "```json") {
    const fence = findLine(text, "```", line.next);
    if (!fence) return text.length + 1;
    const afterFence = skipBlankLines(text, fence.next);
    // Older hosts add a hint line after the Conversation info block, set apart by blank lines.
    const hint = readLine(text, afterFence);
    const separator = hint && readLine(text, hint.next);
    if (
      hint &&
      header.trimmed === `Conversation info: ${CONTEXT_MARKER}` &&
      hint.start > fence.next &&
      text.slice(hint.start, hint.end).replace(/\r$/u, "") === LEGACY_REQUESTER_PROFILE_HINT &&
      (separator === undefined || separator.trimmed === "") &&
      isLegacyHintJson(text.slice(line.next, fence.start))
    ) {
      return skipBlankLines(text, hint.next);
    }
    return afterFence;
  }
  while (line && line.trimmed !== "") line = readLine(text, line.next);
  return skipBlankLines(text, line?.start ?? text.length + 1);
}

function removeSpans(text: string, spans: Span[]): string {
  if (spans.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    // A span that runs to the end of the text also takes the newline before it.
    const start = span.next > text.length && span.start > 0 ? span.start - 1 : span.start;
    parts.push(text.slice(cursor, Math.max(cursor, start)));
    cursor = span.next;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function stripActiveMemoryBlocks(text: string): string {
  if (!text.includes(ACTIVE_MEMORY_OPEN_TAG)) return text;
  const spans: Span[] = [];
  let header = findLine(text, ACTIVE_MEMORY_CONTEXT_HEADER);
  while (header) {
    const open = readLine(text, header.next);
    const close =
      open?.trimmed === ACTIVE_MEMORY_OPEN_TAG
        ? findLine(text, ACTIVE_MEMORY_CLOSE_TAG, open.next)
        : undefined;
    const next = close ? skipBlankLines(text, close.next) : header.next;
    if (close) spans.push({ start: header.start, next });
    header = findLine(text, ACTIVE_MEMORY_CONTEXT_HEADER, next);
  }
  return removeSpans(text, spans);
}

/** Removes the inbound metadata OpenClaw adds around a user's message. */
export function stripOpenClawMetadata(text: string): string {
  const withoutTimestamp = text.replace(LEADING_TIMESTAMP, "");
  if (!hasMetadataSentinel(withoutTimestamp)) return withoutTimestamp;

  const source = stripActiveMemoryBlocks(withoutTimestamp);
  const spans: Span[] = [];
  const tokens = new RegExp(
    [CONTEXT_MARKER, ...DELIVERY_HINTS]
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "g",
  );
  for (let match = tokens.exec(source); match; match = tokens.exec(source)) {
    const start = source.lastIndexOf("\n", match.index - 1) + 1;
    const line = readLine(source, start);
    if (line === undefined) break;
    tokens.lastIndex = line.next;
    if (line.trimmed === CHANNEL_CONTEXT_HEADER) {
      spans.push({ start, next: source.length + 1 });
      break;
    }
    if (isContextHeader(line.trimmed)) {
      tokens.lastIndex = blockEnd(source, line);
      spans.push({ start, next: tokens.lastIndex });
    } else if (DELIVERY_HINTS.includes(line.trimmed)) {
      spans.push({ start, next: line.next });
    }
  }
  return removeSpans(source, spans)
    .replace(/^(?:\r?\n)+/u, "")
    .replace(/(?:\r?\n)+$/u, "")
    .replace(LEADING_TIMESTAMP, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * True for a message the agent's owner typed in a direct chat. event.messages is the whole
 * session history, and with the default dmScope every sender's DMs share one session, so
 * only an explicit owner mark counts; a missing mark means unknown and is dropped.
 */
export function isOwnerUserMessage(message: unknown): boolean {
  if (!isRecord(message) || message.role !== "user") return false;
  if (message.display === false) return false;
  const provenance = message.provenance;
  if (provenance !== undefined) {
    if (!isRecord(provenance) || provenance.kind !== "external_user") return false;
  }
  const meta = message.__openclaw;
  return isRecord(meta) && meta.senderIsOwner === true;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts.join("\n");
}

/** The owner's own prompts from a session history, oldest first. */
export function extractUserPrompts(messages: unknown[]): string[] {
  const prompts: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || !isOwnerUserMessage(message)) continue;
    const text = stripOpenClawMetadata(messageText(message.content)).trim();
    if (text === "" || text.startsWith("<") || text.startsWith("Caveat:")) continue;
    prompts.push(text);
  }
  return prompts;
}
