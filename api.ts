import { DEFAULT_SYSTEM_PROMPT, MacroSettings } from './settings';

// We use the platform `fetch` (not Obsidian's `requestUrl`) because we need
// the response as a ReadableStream — `requestUrl` buffers the full body and
// drops the streaming. `fetch` is available on both desktop and mobile, so
// the plugin works in either environment.

export interface StreamCallbacks {
  // Called for every non-empty delta as it arrives.
  onDelta: (delta: string) => void;
  // Called once the stream completes successfully. `full` is the
  // concatenation of every onDelta payload.
  onDone: (full: string) => void;
  // Called on transport, parse, or HTTP-status failures.
  onError: (err: Error) => void;
}

export interface StreamHandle {
  abort: () => void;
}

export function streamMacro(
  settings: MacroSettings,
  prompt: string,
  context: string,
  cb: StreamCallbacks,
): StreamHandle {
  if (!settings.apiKey) {
    cb.onError(new Error('No API key configured'));
    return { abort: () => {} };
  }

  const limit = settings.contextChars;
  const trimmedContext =
    limit >= 0 && context.length > limit
      ? context.slice(context.length - limit)
      : context;
  const userMsg = `Preceding text:\n${trimmedContext}\n\nMacro: ${prompt}`;
  const system = settings.systemPrompt || DEFAULT_SYSTEM_PROMPT;

  const baseUrl = settings.baseUrl.replace(/\/$/, '');
  let url: string;
  try {
    url = new URL(`${baseUrl}/chat/completions`).toString();
  } catch {
    cb.onError(new Error('Invalid base URL'));
    return { abort: () => {} };
  }

  const payload = JSON.stringify({
    model: settings.model,
    stream: true,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMsg },
    ],
  });

  const controller = new AbortController();
  let aborted = false;
  let fullText = '';

  void (async () => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: payload,
        signal: controller.signal,
      });
    } catch (err) {
      if (aborted) return;
      cb.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        // ignore
      }
      if (aborted) return;
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(body) as { error?: { message?: string } };
        const errMsg = j?.error?.message;
        if (typeof errMsg === 'string' && errMsg.length > 0) msg = errMsg;
      } catch {
        if (body) msg = `${msg}: ${body.slice(0, 200)}`;
      }
      cb.onError(new Error(msg));
      return;
    }

    if (!res.body) {
      cb.onError(new Error('Response has no body'));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (aborted) return;
        const chunk = decoder.decode(value, { stream: true });
        // Normalize CRLF to LF so the '\n\n' delimiter check catches both.
        buf += chunk.replace(/\r\n/g, '\n');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]' || data.length === 0) continue;
            try {
              const j = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: unknown } }>;
              };
              const delta = j?.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta.length > 0) {
                fullText += delta;
                cb.onDelta(delta);
              }
            } catch {
              // Defensive: skip malformed JSON rather than killing the stream.
            }
          }
        }
      }
    } catch (err) {
      if (aborted) return;
      cb.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (!aborted) cb.onDone(fullText);
  })();

  return {
    abort: () => {
      aborted = true;
      try {
        controller.abort();
      } catch {
        // ignore — best-effort
      }
    },
  };
}
