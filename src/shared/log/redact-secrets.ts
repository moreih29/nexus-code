export function redactLogSecrets(text: string): string {
  return text
    .replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/?"'<>#]+@/gi, "$1[redacted]@")
    .replace(
      /(\b(?:token|access[_-]token|refresh[_-]token|id[_-]token|api[_-]key)[ \t]*=[ \t]*|[?&](?:ticket|code|client_secret|signature|password)=)[^&\s"'<>#]+/gi,
      "$1[redacted]",
    )
    .replace(
      /(\bauthorization["']?[ \t]*[:=][ \t]*)(?:(?:digest|aws4-hmac-sha256)[ \t]+[^\r\n}]+|(?:[a-z][\w-]*[ \t]+)?(?:"(?:\\.|[^"\\\r\n])*"?|'(?:\\.|[^'\\\r\n])*'?|[^\s,"';}]+))/gi,
      "$1[redacted]",
    )
    .replace(
      /(\bbearer[ \t]+)(?:"(?:\\.|[^"\\\r\n])*"?|'(?:\\.|[^'\\\r\n])*'?|[^\s,"';}]+)/gi,
      "$1[redacted]",
    )
    .replace(
      /(\b[a-z_][a-z\d_]*_(?:key|token|secret)["']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\\r\n])*"?|'(?:\\.|[^'\\\r\n])*'?|[^\s,"';}]+)/gi,
      "$1[redacted]",
    );
}
