import { EncryptedBlob } from './crypto';

// MacroSettings is the in-memory shape. `apiKey` lives here for runtime use
// but is NOT persisted directly; the persistence layer (main.ts loadSettings /
// saveSettings) translates between this shape and what's on disk: it strips
// `apiKey` and writes `apiKeyBlob` (the encrypted form) instead.
export interface MacroSettings {
  apiKey: string;
  apiKeyBlob: EncryptedBlob | null;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  contextChars: number;
  openDelim: string;
  closeDelim: string;
}

export const DEFAULT_SYSTEM_PROMPT =
  'You expand inline macros embedded in markdown notes. ' +
  'You will be given some preceding text from the note for context, and a macro request. ' +
  'Reply with ONLY the replacement text — no preamble, no quotes, no markdown code fencing, no commentary. Be concise.';

export const DEFAULT_SETTINGS: MacroSettings = {
  apiKey: '',
  apiKeyBlob: null,
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  contextChars: 1500,
  openDelim: '!!',
  closeDelim: '!',
};
