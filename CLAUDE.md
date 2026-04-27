# Obsidian plugin port: inline AI macros

A port of the parent project's `!!prompt!` macro feature into an Obsidian plugin. Type `!!summarize the previous paragraph!`, the closing `!` fires it, the model's response replaces the macro source in place. Delimiters and visual treatment have diverged from the parent — see below.

## Files

- `manifest.json` — plugin metadata (id `implicit-macros`).
- `main.ts` — `Plugin` subclass + `PluginSettingTab` UI. Owns the load/save lifecycle, including the API-key migration from v0.1.0 plaintext storage.
- `settings.ts` — `MacroSettings` interface (in-memory shape with plaintext `apiKey`), `DEFAULT_SETTINGS`, `DEFAULT_SYSTEM_PROMPT`. The persisted shape is a structural superset that swaps `apiKey` for `apiKeyBlob`.
- `crypto.ts` — `encryptString` / `decryptString` over AES-GCM with a per-device key in `localStorage`. See **API key encryption** below.
- `macros.ts` — All CM6 logic: `activeMacrosField` (StateField), detector (`<close-last-char>`-insertion gated), typing-indicator ViewPlugin (greys the in-progress `<open>prompt`), overlay ViewPlugin (renders a `MacroDotsWidget` per range), the dot-animation ticker, and the `fireMacro` glue. Exports `MacroHooks` and `buildMacroExtension`.
- `api.ts` — `runMacro(settings, prompt, context)` — single OpenAI-compatible chat completion call via Obsidian's `requestUrl` (which bypasses CORS by routing through Electron main).
- `styles.css` — `.cm-macro-typing` (typing indicator) and `.cm-macro-dots` / `.cm-macro-dot` (in-flight braille spinner). Animation is JS-driven (see below).
- `esbuild.config.mjs` — bundle config; externalizes `obsidian` and all `@codemirror/*` / `@lezer/*` so the plugin reuses Obsidian's bundled copies.

## How it differs from the parent project

- **No server.** The Go macro handler (`server/internal/api/ai.go`) is replaced by `api.ts` calling the chat endpoint directly. Settings live in the vault's `.obsidian/plugins/implicit-macros/data.json`.
- **No callback decoupling.** The parent's editor exposed an `onMacroFire` callback so `+page.svelte` could orchestrate (`startMacro` → fetch → `applyMacroResult`/`dropMacro`). Here the detector ViewPlugin owns the full pipeline; the plugin is the only orchestrator.
- **Customizable delimiters** (this port; not in parent). Open and close strings are configurable in settings; defaults match the parent (`!!` / `!`). Walk-back uses `String.lastIndexOf` against the configured opener instead of single-`!` matching.
- **In-flight visual is per-character.** Parent renders a greyed/italic mark on the macro range plus a spinner widget at the trailing end. This port REPLACES the entire range with a `MacroDotsWidget` that renders one inline span per character, each cycling through 8 braille frames (`⠋⠙⠹⠸⠼⠴⠦⠧`) on a shared `setInterval`, offset by character index for a wave effect. Source text is preserved in the doc; only the rendering changes.
- **Encrypted API key at rest.** Parent stores plaintext in server-side `ai-config.json`. This port encrypts the key with AES-GCM using a per-device key kept in `localStorage`. See below.
- **`Notice` instead of toast.** Failures surface via Obsidian's `new Notice(...)`. Same UX intent — non-blocking error feedback.

## Grammar invariants

- A macro is `<open>prompt<close>` where `open` and `close` are configurable. Defaults: `!!` and `!`.
- Prompt is non-empty and its first character is non-whitespace.
- Prompt does NOT contain the close-string anywhere — this preserves the first-close-match invariant (the user's perceived close is always the first one after the opener).
- Open and close must be non-empty and contain no newlines (settings UI enforces this).
- Macros are single-line.
- Macros inside fenced code, indented code, and inline backticks are NOT parsed (`insideCode` walks the Lezer tree for `InlineCode` / `FencedCode` / `CodeBlock` / `CodeText`).
- Auto-fire is gated on `tr.docChanged` AND a freshly-inserted close-last-char. Opening a note containing a complete macro does not re-fire.

## API key encryption

Threat model: protect against accidental disclosure (vault sync conflicts, cloud backups, GitHub commits, screenshots of `data.json`, casual inspection of synced files). Not a defense against an attacker with full read access to the device's app data — they can grab the localStorage key and decrypt.

How it works:
1. On first encrypt, `crypto.ts` generates a 32-byte random AES-256-GCM key, base64-encodes it, and stores it under `localStorage['implicitMacrosKey']`. Obsidian's localStorage lives in Electron's per-app data directory (NOT in the vault), so syncing the vault doesn't carry the key.
2. `encryptString(plain)` returns `{iv, ct}` both base64. The IV is fresh (12 random bytes) per encryption.
3. `data.json` only ever contains `apiKeyBlob: {iv, ct}` — never the plaintext.
4. On `loadSettings`, the blob is decrypted into the in-memory `settings.apiKey`. If decryption fails (key was rotated or vault was copied to a new device), the in-memory value stays empty and a `Notice` prompts the user to re-enter.

Migration: v0.1.0 stored `apiKey` as plaintext in `data.json`. `loadSettings` detects this, copies the value into memory, and immediately calls `saveSettings` which writes the encrypted blob and drops the plain field. Idempotent; safe to run repeatedly.

There is no real OS-keychain encryption here. Electron's `safeStorage` would do that, but Obsidian doesn't expose it to plugin code (it's main-process only and there's no IPC channel from plugin → main for encryption). If/when Obsidian ships a plugin API for safe-storage, switching is a one-file change in `crypto.ts`.

## Build

```bash
npm install --cache ./.npm-cache   # parent CLAUDE.md notes the sandbox quirk
npm run dev                        # esbuild watch → main.js
npm run build                      # tsc --noEmit + esbuild production
```

To install into a vault for testing:

```bash
mkdir -p /path/to/vault/.obsidian/plugins/implicit-macros
cp manifest.json main.js styles.css /path/to/vault/.obsidian/plugins/implicit-macros/
```

Then enable under Obsidian → Settings → Community plugins. (Disable Restricted Mode first.)

## Known limitations

- `requestUrl` doesn't expose `AbortSignal`. Closing the file mid-flight does not cancel the network call; the response just lands and `applyMacroResult` no-ops if the range was edited away or the view torn down.
- Reading view (rendered markdown) doesn't run CM6 extensions, so macros only fire in source / live-preview modes.
- The braille animation uses a single shared `setInterval` at 100 ms cadence. Disconnected DOM nodes are GC'd from the live-dots set on each tick (`isConnected` check). The interval auto-stops when no dots are alive and restarts on the next widget mount.
- Custom delimiters where `open === close` work but the walk-back semantics get unusual. If you set both to `*`, the macro `*foo*` fires on the second `*`. Not recommended; not blocked.
