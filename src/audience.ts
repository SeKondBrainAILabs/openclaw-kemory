export interface AudienceContext {
  memoryAudience?: { kind: string };
  trigger?: string;
  sessionKey?: string;
  inputProvenance?: { kind: string };
}

// OpenClaw puts no incognito flag on the hook context, so it is read from the
// session key the same way OpenClaw's own routing does.
const INCOGNITO_KEY =
  /^agent:[^:]+:(?:dashboard|subagent|internal-session-effects):incognito-[^:]+$/u;

export function isIncognitoSessionKey(key: string | undefined): boolean {
  return key !== undefined && INCOGNITO_KEY.test(key);
}

/**
 * The one privacy gate for recall, capture and tools: memory is only read or
 * written for a direct turn from the agent's owner. Groups, other senders,
 * cron, heartbeat, incognito sessions and inter-session input are all refused.
 */
export function memoryAllowed(ctx: AudienceContext | undefined): boolean {
  if (!ctx) return false;
  if (ctx.memoryAudience?.kind !== "owner-private") return false;
  if (ctx.trigger !== undefined && ctx.trigger !== "user") return false;
  if (isIncognitoSessionKey(ctx.sessionKey)) return false;
  if (ctx.inputProvenance !== undefined && ctx.inputProvenance.kind !== "external_user") {
    return false;
  }
  return true;
}
