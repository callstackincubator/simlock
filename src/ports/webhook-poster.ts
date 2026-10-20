export interface WebhookRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export interface WebhookPoster {
  post(request: WebhookRequest): Promise<{ status: number }>;
}

/**
 * why: `redirect: "manual"` keeps a message on the URL the operator wrote, and the response body is cancelled unread because only the status is read.
 */
export class FetchWebhookPoster implements WebhookPoster {
  async post(request: WebhookRequest): Promise<{ status: number }> {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: request.signal,
    });
    await response.body?.cancel();
    return { status: response.status };
  }
}
