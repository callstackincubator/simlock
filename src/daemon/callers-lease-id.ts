// why: a worker's refusal is a claim, so the gateway reads at most this much of it, as the stream module does.
const MAX_REFUSAL_BYTES = 16 * 1024;

const WORKER_LEASE_ID_CODES: ReadonlySet<string> = new Set(["UNKNOWN_LEASE", "LEASE_FILES_FULL"]);

/** why: the worker names a lease by its own id, which the caller never saw; the gateway puts back the id the caller used in the two refusals that name it, and relays every other body as the worker sent it. */
export async function withCallersLeaseId(
  answer: Response,
  workerLeaseId: string,
  callersLeaseId: string,
): Promise<Response> {
  if ((answer.status !== 404 && answer.status !== 413) || answer.body === null) return answer;
  const reader = answer.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let ended = false;
  while (size <= MAX_REFUSAL_BYTES) {
    const step = await reader.read();
    if (step.done) {
      ended = true;
      break;
    }
    chunks.push(step.value);
    size += step.value.length;
  }
  if (ended) {
    const rewritten = rewrite(Buffer.concat(chunks).toString(), workerLeaseId, callersLeaseId);
    if (rewritten !== undefined) {
      const headers = new Headers(answer.headers);
      headers.delete("content-length");
      headers.delete("simlock-content-length");
      return new Response(rewritten, { headers, status: answer.status });
    }
  }
  return new Response(stitched(chunks, reader), { headers: answer.headers, status: answer.status });
}

function rewrite(text: string, workerLeaseId: string, callersLeaseId: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  if (typeof error !== "object" || error === null) return undefined;
  const fields = error as { code?: unknown; message?: unknown };
  if (typeof fields.code !== "string" || !WORKER_LEASE_ID_CODES.has(fields.code)) return undefined;
  return JSON.stringify({
    error: {
      ...error,
      leaseId: callersLeaseId,
      ...(typeof fields.message === "string"
        ? { message: fields.message.replaceAll(workerLeaseId, callersLeaseId) }
        : {}),
    },
  });
}

function stitched(
  chunks: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  const pending = [...chunks];
  return new ReadableStream<Uint8Array>(
    {
      cancel: (reason) => reader.cancel(reason),
      async pull(controller) {
        const next = pending.shift();
        if (next !== undefined) {
          controller.enqueue(next);
          return;
        }
        const step = await reader.read();
        if (step.done) controller.close();
        else controller.enqueue(step.value);
      },
    },
    { highWaterMark: 0 },
  );
}
