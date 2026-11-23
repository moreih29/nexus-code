export const API_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const RESPONSE_TOO_LARGE = "response-too-large";

export class ResponseTooLargeError extends Error {
  readonly code = RESPONSE_TOO_LARGE;

  constructor(maxBytes: number) {
    super(`HTTP response exceeded ${maxBytes} bytes`);
  }
}

export async function readResponseText(
  response: Response,
  maxBytes = API_RESPONSE_MAX_BYTES,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const text: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) {
        const error = new ResponseTooLargeError(maxBytes);
        void reader.cancel(error).catch(() => {});
        throw error;
      }
      text.push(decoder.decode(result.value, { stream: true }));
    }
    text.push(decoder.decode());
    return text.join("");
  } finally {
    reader.releaseLock();
  }
}
