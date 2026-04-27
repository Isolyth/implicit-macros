import { DEFAULT_SYSTEM_PROMPT, MacroSettings } from './settings';

// We use Node's https/http directly (via `require`) instead of Obsidian's
// `requestUrl` because requestUrl buffers the full response and doesn't
// expose the underlying stream. Going through Node also dodges browser CORS:
// OpenAI's API does not allow direct browser-origin calls, but a Node-level
// HTTPS request from inside Electron is indistinguishable from any other
// server-to-server call. Module names are externalized in esbuild, so they
// resolve to Electron's runtime Node modules.

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
  let url: URL;
  try {
    url = new URL(`${baseUrl}/chat/completions`);
  } catch {
    cb.onError(new Error('Invalid base URL'));
    return { abort: () => {} };
  }

  const isHttps = url.protocol === 'https:';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const lib: any = isHttps ? require('https') : require('http');

  const payload = JSON.stringify({
    model: settings.model,
    stream: true,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMsg },
    ],
  });

  let aborted = false;
  let fullText = '';
  let req: any = null;

  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload).toString(),
      Accept: 'text/event-stream',
      // Disable any compression that might buffer the response before
      // delivering it. Some providers/CDNs gzip SSE responses, which
      // collapses the visible streaming.
      'Accept-Encoding': 'identity',
    },
  };

  req = lib.request(options, (res: any) => {
    if (res.statusCode >= 400) {
      let body = '';
      res.on('data', (chunk: any) => {
        body += chunk.toString('utf8');
      });
      res.on('end', () => {
        if (aborted) return;
        let msg = `HTTP ${res.statusCode}`;
        try {
          const j = JSON.parse(body);
          if (j?.error?.message) msg = j.error.message;
        } catch {
          if (body) msg = `${msg}: ${body.slice(0, 200)}`;
        }
        cb.onError(new Error(msg));
      });
      return;
    }

    // SSE framing: events separated by '\n\n' (or '\r\n\r\n'), each event
    // has 'data: <json>' lines. The terminal event is `data: [DONE]`.
    // Partial chunks accumulate in `buf` until we see a delimiter.
    let buf = '';
    let chunkCount = 0;
    let firstChunkTime: number | null = null;
    let deltaCount = 0;
    const startTime = Date.now();
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      if (aborted) return;
      chunkCount++;
      if (firstChunkTime === null) firstChunkTime = Date.now();
      console.log(
        `[implicit-macros] chunk #${chunkCount} +${Date.now() - startTime}ms: ${chunk.length} chars`,
      );
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
            const j = JSON.parse(data);
            const delta = j?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              fullText += delta;
              deltaCount++;
              cb.onDelta(delta);
            }
          } catch {
            // Defensive: skip malformed JSON rather than killing the stream.
          }
        }
      }
    });
    res.on('end', () => {
      console.log(
        `[implicit-macros] stream ended after ${chunkCount} chunk(s), ${deltaCount} delta(s), ${Date.now() - startTime}ms total`,
      );
      if (!aborted) cb.onDone(fullText);
    });
    res.on('error', (err: Error) => {
      if (!aborted) cb.onError(err);
    });
  });

  req.on('error', (err: Error) => {
    if (!aborted) cb.onError(err);
  });

  req.write(payload);
  req.end();

  return {
    abort: () => {
      aborted = true;
      try {
        req?.destroy();
      } catch {
        // ignore — best-effort
      }
    },
  };
}
