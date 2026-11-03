// Same pattern as kemory-cli internal/hook/redact.go; keep the two in step.
const CREDENTIAL_PATTERN =
  /(bearer\s+[\w\-.]{8,}|(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)\s*[:=]\s*["']?[^\s"',;}]{6,}|sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN[^-]+PRIVATE KEY-----)/;

/** Replaces credentials in free text with [REDACTED]. */
export function redact(text: string): string {
  // A new RegExp per call: a shared /g regex would carry lastIndex between calls.
  return text.replace(new RegExp(CREDENTIAL_PATTERN.source, "gi"), "[REDACTED]");
}
