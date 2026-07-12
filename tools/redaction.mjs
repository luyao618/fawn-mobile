const SECRET_ASSIGNMENT = /(authorization|api[-_]?key|token|secret|password)\s*[:=]\s*([^\s,;]+)/gi;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/-]+/gi;
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi;

export function redactOutput(value) {
  return String(value)
    .replace(PRIVATE_KEY, "[REDACTED PRIVATE KEY]")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(SECRET_ASSIGNMENT, "$1=[REDACTED]");
}
