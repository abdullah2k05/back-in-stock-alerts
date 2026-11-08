'use strict';

class EmailError extends Error {
  constructor(message, { permanent = false, status = null, cause } = {}) {
    super(message);
    this.name = 'EmailError';
    this.permanent = permanent;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

function createEmailClient({ baseUrl, apiKey, from, timeoutMs = 10000 }) {
  async function send({ to, subject, html, text, idempotencyKey }) {
    let response;
    try {
      response = await fetch(`${baseUrl}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ from, to: [to], subject, html, text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      throw new EmailError(
        timedOut ? `Email API timed out after ${timeoutMs}ms` : `Email API network error: ${error.message}`,
        { permanent: false, cause: error }
      );
    }

    if (response.ok) {
      let body = {};
      try {
        body = await response.json();
      } catch {
        /* an accepted email with a non-JSON body is still accepted */
      }
      return { id: body.id || null, status: response.status };
    }

    let detail = '';
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      /* ignore */
    }

    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new EmailError(`Email API returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`, {
      permanent: !retryable,
      status: response.status,
    });
  }

  return { send };
}

module.exports = { createEmailClient, EmailError };
