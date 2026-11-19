/** Sends one byte over the limit without Content-Length and records cancellation. */
export function oversizedResponse(mebibytes: number) {
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  let remaining = mebibytes;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (remaining > 0) {
          remaining -= 1;
          controller.enqueue(chunk);
        } else if (remaining === 0) {
          remaining = -1;
          controller.enqueue(Uint8Array.of(0x20));
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { fetch: async () => new Response(body), cancelled: () => cancelled };
}
