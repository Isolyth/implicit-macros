import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { buildMacroExtension, MacroHooks } from './macros';
import { streamMacro } from './api';
import { decryptString, encryptString } from './crypto';
import { DEFAULT_SETTINGS, MacroSettings } from './settings';

interface PersistedV1 {
  // legacy plaintext field — present in data.json from v0.1.0; migrated
  // into the encrypted blob on first save under v0.2.
  apiKey?: string;
  apiKeyBlob?: MacroSettings['apiKeyBlob'];
  baseUrl?: string;
  model?: string;
  systemPrompt?: string;
  contextChars?: number;
  openDelim?: string;
  closeDelim?: string;
}

export default class ImplicitMacrosPlugin extends Plugin {
  settings: MacroSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    await this.loadSettings();
    const hooks: MacroHooks = {
      getDelims: () => ({
        open: this.settings.openDelim,
        close: this.settings.closeDelim,
      }),
      stream: (prompt, context, cb) => streamMacro(this.settings, prompt, context, cb),
      notify: msg => new Notice(msg),
    };
    this.registerEditorExtension(buildMacroExtension(hooks));
    this.addSettingTab(new MacroSettingTab(this.app, this));
  }

  async loadSettings() {
    const raw = (await this.loadData()) as PersistedV1 | null;
    this.settings = { ...DEFAULT_SETTINGS };
    if (!raw) return;

    if (raw.baseUrl !== undefined) this.settings.baseUrl = raw.baseUrl;
    if (raw.model !== undefined) this.settings.model = raw.model;
    if (raw.systemPrompt !== undefined) this.settings.systemPrompt = raw.systemPrompt;
    if (raw.contextChars !== undefined) this.settings.contextChars = raw.contextChars;
    if (raw.openDelim !== undefined) this.settings.openDelim = raw.openDelim;
    if (raw.closeDelim !== undefined) this.settings.closeDelim = raw.closeDelim;
    if (raw.apiKeyBlob) this.settings.apiKeyBlob = raw.apiKeyBlob;

    if (raw.apiKeyBlob) {
      const plain = await decryptString(this.app, raw.apiKeyBlob);
      if (plain !== null) {
        this.settings.apiKey = plain;
      } else {
        new Notice(
          'Implicit macros: stored API key could not be decrypted on this device. Re-enter it in plugin settings.',
        );
      }
    } else if (typeof raw.apiKey === 'string' && raw.apiKey.length > 0) {
      // Migration from v0.1.0 plaintext storage. The next saveSettings()
      // writes the encrypted blob and drops the plain field.
      this.settings.apiKey = raw.apiKey;
      await this.saveSettings();
    }
  }

  async saveSettings() {
    const persisted: PersistedV1 = {
      baseUrl: this.settings.baseUrl,
      model: this.settings.model,
      systemPrompt: this.settings.systemPrompt,
      contextChars: this.settings.contextChars,
      openDelim: this.settings.openDelim,
      closeDelim: this.settings.closeDelim,
      apiKeyBlob: null,
    };
    if (this.settings.apiKey) {
      persisted.apiKeyBlob = await encryptString(this.app, this.settings.apiKey);
      this.settings.apiKeyBlob = persisted.apiKeyBlob;
    } else {
      this.settings.apiKeyBlob = null;
    }
    await this.saveData(persisted);
  }
}

class MacroSettingTab extends PluginSettingTab {
  plugin: ImplicitMacrosPlugin;

  constructor(app: App, plugin: ImplicitMacrosPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('API key')
      .setDesc(
        'API key for an OpenAI-compatible endpoint. Encrypted at rest with a per-device key; the encrypted blob is what lands in data.json. Re-enter on each device.',
      )
      .addText(t => {
        t.inputEl.type = 'password';
        t.setPlaceholder('sk-...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async v => {
            this.plugin.settings.apiKey = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Base URL')
      .setDesc('Base URL for an OpenAI-compatible chat completions endpoint.')
      .addText(t =>
        t
          .setPlaceholder('https://api.openai.com/v1')
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async v => {
            this.plugin.settings.baseUrl = v.trim().replace(/\/$/, '');
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Model')
      .setDesc('Chat completions model ID.')
      .addText(t =>
        t
          .setPlaceholder('gpt-4o-mini')
          .setValue(this.plugin.settings.model)
          .onChange(async v => {
            this.plugin.settings.model = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('System prompt')
      .setDesc('Sent as the system message on every macro call. Empty falls back to the built-in default.')
      .addTextArea(t => {
        t.setValue(this.plugin.settings.systemPrompt).onChange(async v => {
          this.plugin.settings.systemPrompt = v;
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 6;
        t.inputEl.addClass('implicit-macros-prompt-textarea');
      });

    new Setting(containerEl)
      .setName('Context chars')
      .setDesc('How many characters of preceding note text to include as grounding.')
      .addText(t =>
        t
          .setValue(String(this.plugin.settings.contextChars))
          .onChange(async v => {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0) return;
            this.plugin.settings.contextChars = Math.floor(n);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName('Macro syntax').setHeading();

    new Setting(containerEl)
      .setName('Open delimiter')
      .setDesc('Characters that begin a macro. Default: !!')
      .addText(t =>
        t
          .setPlaceholder('!!')
          .setValue(this.plugin.settings.openDelim)
          .onChange(async v => {
            const cleaned = v.replace(/[\r\n]/g, '');
            if (cleaned.length === 0) return;
            this.plugin.settings.openDelim = cleaned;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Close delimiter')
      .setDesc('Characters that close a macro and trigger the call. Default: !')
      .addText(t =>
        t
          .setPlaceholder('!')
          .setValue(this.plugin.settings.closeDelim)
          .onChange(async v => {
            const cleaned = v.replace(/[\r\n]/g, '');
            if (cleaned.length === 0) return;
            this.plugin.settings.closeDelim = cleaned;
            await this.plugin.saveSettings();
          }),
      );
  }
}
