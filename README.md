# Implicit Macros

An Obsidian plugin for inline AI macros. Type `!!prompt!`, the closing `!` fires a call to an OpenAI-compatible chat endpoint, and the response streams back in place of the source.

While the call is running, the macro text is replaced with animated braille-dot spinners sized to match the original width. As tokens arrive they replace the spinners; each freshly inserted chunk briefly highlights in the accent color and fades to normal over 1.5 seconds.

## Install

Install via Obsidian's Community Plugins browser (search for **Implicit Macros**), or install from source:

1. Build the plugin from source (see below) — produces `main.js`.
2. Make sure you have `manifest.json`, `main.js`, and `styles.css`.
3. Copy them to `<your vault>/.obsidian/plugins/implicit-macros/`.
4. In Obsidian: Settings → Community plugins → disable Restricted Mode if needed → Refresh under Installed plugins → enable **Implicit Macros**.

For active development, symlink this repo into your vault's plugin directory and use the [Hot Reload](https://github.com/pjeby/hot-reload) plugin so rebuilds pick up automatically.

## Build from source

```bash
git clone <this repo>
cd implicit-macros
npm install
npm run build      # tsc --noEmit + esbuild → main.js
# or
npm run dev        # esbuild watch mode
```

External imports (`obsidian`, every `@codemirror/*` and `@lezer/*` module, Node builtins) are not bundled — they resolve to Obsidian's runtime copies.

## Setup

After enabling, open Settings → Implicit Macros and configure:

| Setting | Default | Notes |
| --- | --- | --- |
| API key | (empty) | OpenAI-compatible bearer token. Encrypted at rest with a per-device AES-256-GCM key kept in `localStorage`; the encrypted blob is what lands in `data.json`. You re-enter on each device. |
| Base URL | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint. |
| Model | `gpt-4o-mini` | Chat completions model id. |
| System prompt | built-in | Sent on every macro call; empty falls back to the default. |
| Context chars | 1500 | How many characters of preceding note text to include as grounding. |
| Open delimiter | `!!` | Customize to `@!`, `<<`, etc. |
| Close delimiter | `!` | Same — anything non-empty without newlines. |

## Usage

```
The Idiot is a novel by !!one sentence on its central theme!
```

The closing delimiter fires the call. The macro is single-line and won't fire inside fenced code, indented code, or inline backtick spans.

## Data flow and privacy

This plugin sends data to a third-party AI service that **you** configure. Specifically, when a macro fires:

- **What is sent:** the macro prompt itself, plus up to `Context chars` (default 1500) characters of preceding note text, plus the system prompt. Together these become a single chat-completions request.
- **Where it goes:** the OpenAI-compatible endpoint set in **Base URL** (default `https://api.openai.com/v1`). You can point this at OpenAI, a local server (Ollama, llama.cpp, LM Studio, etc.), or any other compatible provider.
- **Authentication:** your API key is sent as a `Bearer` token to the configured endpoint and nowhere else. It is encrypted at rest in `data.json` with a per-device AES-256-GCM key.
- **No telemetry:** the plugin does not send anything to the author or to any third party other than the endpoint you configure.

If you set Base URL to a remote provider, that provider will receive the prompt and surrounding note context every time a macro fires — review their data-retention policy before pointing this plugin at sensitive notes.

## License

GPL-3.0-only. Forks must remain open-source under the same license — see `LICENSE`.
