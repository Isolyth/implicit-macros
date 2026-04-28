import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { EditorState, Extension, Range, StateEffect, StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { SyntaxNode } from '@lezer/common';
import { StreamCallbacks, StreamHandle } from './api';

// Hooks the plugin supplies to the editor extension. Keeps macros.ts free of
// any direct dependency on the Plugin class or Obsidian APIs.
export interface MacroHooks {
  getDelims(): { open: string; close: string };
  stream(prompt: string, context: string, cb: StreamCallbacks): StreamHandle;
  notify(message: string): void;
}

// How much preceding text the editor packs as `context` on the API call.
// The API layer further truncates to settings.contextChars.
const CLIENT_MAX_CONTEXT = 16000;

// Braille frames used for the in-flight character animation. Cycling these
// in order gives a clockwise dot rotation; per-character offset (driven by
// `MacroDotsWidget` index) produces a wave across the macro length.
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];
const FRAME_INTERVAL_MS = 100;

const CODE_CONTEXT_NODES = new Set([
  'InlineCode',
  'FencedCode',
  'CodeBlock',
  'CodeText',
]);

function insideCode(state: EditorState, pos: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  while (node) {
    if (CODE_CONTEXT_NODES.has(node.name)) return true;
    node = node.parent;
  }
  return false;
}

// ---- braille dot animation ---------------------------------------------

interface DotEntry {
  el: HTMLSpanElement;
  offset: number;
}

const liveDots: Set<DotEntry> = new Set();
let frameIndex = 0;
let intervalHandle: number | null = null;

function tickDots(): void {
  let alive = 0;
  for (const entry of liveDots) {
    if (!entry.el.isConnected) {
      liveDots.delete(entry);
      continue;
    }
    entry.el.textContent = BRAILLE_FRAMES[(frameIndex + entry.offset) % BRAILLE_FRAMES.length];
    alive++;
  }
  if (alive === 0) {
    if (intervalHandle !== null) {
      window.clearInterval(intervalHandle);
      intervalHandle = null;
    }
    return;
  }
  frameIndex = (frameIndex + 1) % BRAILLE_FRAMES.length;
}

function ensureTicker(): void {
  if (intervalHandle !== null) return;
  intervalHandle = window.setInterval(tickDots, FRAME_INTERVAL_MS);
}

class MacroDotsWidget extends WidgetType {
  constructor(
    private readonly id: string,
    private readonly length: number,
    // Pixel width of the original macro source as measured before the
    // replace decoration was applied. 0 means "unknown / fall back to
    // intrinsic glyph width."
    private readonly width: number,
  ) {
    super();
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-macro-dots';
    if (this.width > 0) {
      // Dynamic measured widths come from coordsAtPos at runtime, so they
      // can't live in the stylesheet. Custom properties keep the inline
      // surface narrow (one declaration the CSS can pick up).
      wrap.style.setProperty('--macro-dots-w', `${this.width.toFixed(2)}px`);
    }
    const dotW = this.width > 0 && this.length > 0 ? this.width / this.length : 0;
    for (let i = 0; i < this.length; i++) {
      const dot = document.createElement('span');
      dot.className = 'cm-macro-dot';
      if (dotW > 0) {
        dot.style.setProperty('--macro-dot-w', `${dotW.toFixed(3)}px`);
      }
      dot.textContent = BRAILLE_FRAMES[i % BRAILLE_FRAMES.length];
      wrap.appendChild(dot);
      liveDots.add({ el: dot, offset: i });
    }
    ensureTicker();
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof MacroDotsWidget &&
      other.id === this.id &&
      other.length === this.length &&
      Math.abs(other.width - this.width) < 0.5
    );
  }
  destroy(dom: HTMLElement): void {
    const dots = dom.querySelectorAll('.cm-macro-dot');
    for (const entry of [...liveDots]) {
      for (const node of Array.from(dots)) {
        if (entry.el === node) {
          liveDots.delete(entry);
          break;
        }
      }
    }
  }
}

// ---- in-flight macro state ---------------------------------------------

interface MacroRange {
  from: number;
  to: number;
  width: number;
}

const addMacroEffect = StateEffect.define<{
  id: string;
  from: number;
  to: number;
  width: number;
}>();
const removeMacroEffect = StateEffect.define<{ id: string }>();

const activeMacrosField = StateField.define<Map<string, MacroRange>>({
  create() {
    return new Map();
  },
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value.size > 0) {
      const m = new Map<string, MacroRange>();
      for (const [id, r] of value) {
        const from = tr.changes.mapPos(r.from, 1);
        const to = tr.changes.mapPos(r.to, -1);
        if (from < to) m.set(id, { from, to, width: r.width });
      }
      next = m;
    }
    for (const eff of tr.effects) {
      if (eff.is(addMacroEffect)) {
        if (next === value) next = new Map(value);
        next.set(eff.value.id, {
          from: eff.value.from,
          to: eff.value.to,
          width: eff.value.width,
        });
      } else if (eff.is(removeMacroEffect)) {
        if (next === value) next = new Map(value);
        next.delete(eff.value.id);
      }
    }
    return next;
  },
});

// ---- cooling (post-insert color fade) ----------------------------------
//
// Every freshly inserted chunk of streamed text is wrapped in a
// `Decoration.mark` for COOLING_DURATION_MS. CSS keyframes fade the color
// from --text-accent down to --text-normal over the same duration, then a
// setTimeout dispatches removeCoolingEffect to drop the mark. Each chunk
// gets its own id so streamed responses end up with multiple staggered
// fade timelines — a true stream looks like a wave of cooling text; a
// buffered response shows one big chunk fading.

const COOLING_DURATION_MS = 1500;

const addCoolingEffect = StateEffect.define<{ id: string; from: number; to: number }>();
const removeCoolingEffect = StateEffect.define<{ id: string }>();

interface CoolingRange {
  from: number;
  to: number;
}

const coolingField = StateField.define<Map<string, CoolingRange>>({
  create() {
    return new Map();
  },
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value.size > 0) {
      const m = new Map<string, CoolingRange>();
      for (const [id, r] of value) {
        const from = tr.changes.mapPos(r.from, 1);
        const to = tr.changes.mapPos(r.to, -1);
        if (from < to) m.set(id, { from, to });
      }
      next = m;
    }
    for (const eff of tr.effects) {
      if (eff.is(addCoolingEffect)) {
        if (next === value) next = new Map(value);
        next.set(eff.value.id, { from: eff.value.from, to: eff.value.to });
      } else if (eff.is(removeCoolingEffect)) {
        if (next === value) next = new Map(value);
        next.delete(eff.value.id);
      }
    }
    return next;
  },
});

// ---- streaming insertion-point state -----------------------------------
//
// Once the first delta arrives, we transition from "dots replacing the
// macro source" to "real text being written into the doc." `at` is the
// position where the next delta should insert. It maps through every
// transaction's changes, so unrelated edits elsewhere in the doc shift
// it correctly.

const setStreamPosEffect = StateEffect.define<{ id: string; at: number }>();
const removeStreamEffect = StateEffect.define<{ id: string }>();

const streamingMacrosField = StateField.define<Map<string, { at: number }>>({
  create() {
    return new Map();
  },
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value.size > 0) {
      const m = new Map<string, { at: number }>();
      for (const [id, e] of value) {
        m.set(id, { at: tr.changes.mapPos(e.at, 1) });
      }
      next = m;
    }
    for (const eff of tr.effects) {
      if (eff.is(setStreamPosEffect)) {
        if (next === value) next = new Map(value);
        next.set(eff.value.id, { at: eff.value.at });
      } else if (eff.is(removeStreamEffect)) {
        if (next === value) next = new Map(value);
        next.delete(eff.value.id);
      }
    }
    return next;
  },
});

// ---- detection ---------------------------------------------------------

interface MacroFire {
  from: number;
  to: number;
  prompt: string;
  context: string;
}

function checkMacroAt(
  state: EditorState,
  closePos: number,
  open: string,
  close: string,
): MacroFire | null {
  if (open.length === 0 || close.length === 0) return null;
  const minLen = open.length + close.length + 1;
  if (closePos < minLen) return null;

  const closeStart = closePos - close.length;
  if (state.sliceDoc(closeStart, closePos) !== close) return null;

  const line = state.doc.lineAt(closeStart);
  const lineStart = line.from;
  if (closeStart < lineStart + open.length) return null;
  const segment = state.sliceDoc(lineStart, closePos);
  const closeStartInSeg = closeStart - lineStart;

  const fromIdx = closeStartInSeg - open.length;
  if (fromIdx < 0) return null;
  const openerStartInSeg = segment.lastIndexOf(open, fromIdx);
  if (openerStartInSeg === -1) return null;
  const openerEndInSeg = openerStartInSeg + open.length;
  if (openerEndInSeg > closeStartInSeg) return null;

  const prompt = segment.slice(openerEndInSeg, closeStartInSeg);
  if (prompt.length === 0) return null;
  if (/[\s\n]/.test(prompt[0])) return null;
  if (prompt.includes(close)) return null;

  const openerStart = lineStart + openerStartInSeg;
  if (insideCode(state, openerStart)) return null;
  const contextStart = Math.max(0, openerStart - CLIENT_MAX_CONTEXT);
  const context = state.sliceDoc(contextStart, openerStart);
  return { from: openerStart, to: closePos, prompt, context };
}

function newMacroId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'macro-' + Math.random().toString(36).slice(2, 11);
}

// ---- lifecycle helpers -------------------------------------------------

function startMacro(view: EditorView, fire: MacroFire): string | null {
  const slice = view.state.sliceDoc(fire.from, fire.to);
  if (slice.length !== fire.to - fire.from) return null;
  const active = view.state.field(activeMacrosField, false);
  if (active) {
    for (const r of active.values()) {
      if (r.from <= fire.from && fire.from < r.to) return null;
    }
  }
  // Measure the source text's pixel width BEFORE the replace decoration
  // hides it. We use this to size the dot wrapper exactly so the spinner
  // matches the original macro's footprint and surrounding text doesn't
  // shift while the macro is in flight.
  let width = 0;
  try {
    const fromCoords = view.coordsAtPos(fire.from, 1);
    const toCoords = view.coordsAtPos(fire.to, -1);
    if (fromCoords && toCoords) {
      width = Math.max(0, toCoords.left - fromCoords.left);
    }
  } catch {
    // If measurement fails (e.g. position not yet rendered), fall back to
    // intrinsic glyph width — slightly wider but still readable.
  }
  const id = newMacroId();
  view.dispatch({
    effects: addMacroEffect.of({ id, from: fire.from, to: fire.to, width }),
  });
  return id;
}

function dropMacro(view: EditorView, id: string): void {
  if (!view.dom.isConnected) return;
  const active = view.state.field(activeMacrosField, false);
  if (active?.has(id)) {
    view.dispatch({ effects: removeMacroEffect.of({ id }) });
  }
}

function endStream(view: EditorView, id: string): void {
  if (!view.dom.isConnected) return;
  const streaming = view.state.field(streamingMacrosField, false);
  if (streaming?.has(id)) {
    try {
      view.dispatch({ effects: removeStreamEffect.of({ id }) });
    } catch {
      // ignore
    }
  }
}

// fireMacro orchestrates the streaming lifecycle. Each onDelta dispatches
// directly — no artificial pacing. If the network truly streams, you see
// each token as it arrives; if the response is buffered, you see it land
// all at once.
function fireMacro(hooks: MacroHooks, view: EditorView, fire: MacroFire): void {
  const id = startMacro(view, fire);
  if (!id) return;

  let phase: 'pending' | 'streaming' | 'done' = 'pending';
  let handle: StreamHandle | null = null;

  const scheduleCooldown = (coolId: string): void => {
    window.setTimeout(() => {
      if (!view.dom.isConnected) return;
      const cooling = view.state.field(coolingField, false);
      if (!cooling?.has(coolId)) return;
      try {
        view.dispatch({ effects: removeCoolingEffect.of({ id: coolId }) });
      } catch {
        // ignore: view destroyed mid-timeout
      }
    }, COOLING_DURATION_MS);
  };

  const applyText = (text: string): boolean => {
    if (text.length === 0) return true;
    if (!view.dom.isConnected || phase === 'done') return false;
    const coolId = newMacroId();
    if (phase === 'pending') {
      const active = view.state.field(activeMacrosField, false);
      const range = active?.get(id);
      if (!range || range.to <= range.from) {
        handle?.abort();
        dropMacro(view, id);
        phase = 'done';
        return false;
      }
      const insertEnd = range.from + text.length;
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        effects: [
          removeMacroEffect.of({ id }),
          setStreamPosEffect.of({ id, at: insertEnd }),
          addCoolingEffect.of({ id: coolId, from: range.from, to: insertEnd }),
        ],
      });
      phase = 'streaming';
      scheduleCooldown(coolId);
      return true;
    }
    const streaming = view.state.field(streamingMacrosField, false);
    const entry = streaming?.get(id);
    if (!entry) {
      handle?.abort();
      phase = 'done';
      return false;
    }
    const at = entry.at;
    const docLen = view.state.doc.length;
    if (at < 0 || at > docLen) {
      handle?.abort();
      endStream(view, id);
      phase = 'done';
      return false;
    }
    view.dispatch({
      changes: { from: at, to: at, insert: text },
      effects: [
        setStreamPosEffect.of({ id, at: at + text.length }),
        addCoolingEffect.of({ id: coolId, from: at, to: at + text.length }),
      ],
    });
    scheduleCooldown(coolId);
    return true;
  };

  handle = hooks.stream(fire.prompt, fire.context, {
    onDelta(delta: string) {
      if (phase === 'done') return;
      applyText(delta);
    },
    onDone(_full: string) {
      if (phase === 'done') return;
      if (phase === 'pending') {
        dropMacro(view, id);
        hooks.notify('Macro: empty response');
        phase = 'done';
        return;
      }
      const streaming = view.state.field(streamingMacrosField, false);
      const at = streaming?.get(id)?.at;
      endStream(view, id);
      phase = 'done';
      if (at != null) {
        requestAnimationFrame(() => {
          if (!view.dom.isConnected) return;
          const block = view.lineBlockAt(at);
          const scrollDOM = view.scrollDOM;
          const margin = 40;
          const viewTop = scrollDOM.scrollTop;
          const viewBottom = viewTop + scrollDOM.clientHeight;
          let target: number | null = null;
          if (block.bottom + margin > viewBottom) {
            target = block.bottom + margin - scrollDOM.clientHeight;
          } else if (block.top - margin < viewTop) {
            target = Math.max(0, block.top - margin);
          }
          if (target != null) {
            scrollDOM.scrollTo({ top: target, behavior: 'smooth' });
          }
        });
      }
    },
    onError(err: Error) {
      if (phase === 'done') return;
      if (phase === 'pending') {
        dropMacro(view, id);
      } else {
        endStream(view, id);
      }
      hooks.notify(`Macro failed: ${err.message ?? err}`);
      phase = 'done';
    },
  });
}

// ---- ViewPlugins -------------------------------------------------------

function makeMacroDetectorPlugin(hooks: MacroHooks) {
  return ViewPlugin.fromClass(
    class {
      update(u: ViewUpdate) {
        if (!u.docChanged) return;
        const { open, close } = hooks.getDelims();
        if (!open || !close) return;
        const lastCloseChar = close.charAt(close.length - 1);
        const view = u.view;
        const fires: MacroFire[] = [];
        for (const tr of u.transactions) {
          tr.changes.iterChanges((_fa, _ta, fromB, _tb, inserted) => {
            const text = inserted.toString();
            if (text.length === 0 || !text.includes(lastCloseChar)) return;
            for (let i = 0; i < text.length; i++) {
              if (text[i] !== lastCloseChar) continue;
              const closePos = fromB + i + 1;
              const fire = checkMacroAt(view.state, closePos, open, close);
              if (fire) fires.push(fire);
            }
          });
        }
        if (fires.length === 0) return;
        Promise.resolve().then(() => {
          for (const f of fires) fireMacro(hooks, view, f);
        });
      }
    },
  );
}

function makeMacroTypingPlugin(hooks: MacroHooks) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) {
          this.decorations = this.build(u.view);
        }
      }
      build(view: EditorView): DecorationSet {
        const { open, close } = hooks.getDelims();
        if (!open || !close) return Decoration.none;
        const { state } = view;
        if (!view.hasFocus) return Decoration.none;
        const cursor = state.selection.main.head;
        const line = state.doc.lineAt(cursor);
        const lineText = state.sliceDoc(line.from, line.to);
        const cursorInLine = cursor - line.from;

        const fromIdx = cursorInLine - open.length;
        if (fromIdx < 0) return Decoration.none;
        const openerStart = lineText.lastIndexOf(open, fromIdx);
        if (openerStart === -1) return Decoration.none;
        const openerEnd = openerStart + open.length;

        const before = lineText.slice(openerEnd, cursorInLine);
        if (before.includes(close)) return Decoration.none;

        let forwardEnd = lineText.length;
        const forwardCloseStart = lineText.indexOf(close, cursorInLine);
        if (forwardCloseStart >= 0) {
          forwardEnd = forwardCloseStart;
          const fullPrompt = before + lineText.slice(cursorInLine, forwardEnd);
          const validPrompt =
            fullPrompt.length > 0 && !/[\s\n]/.test(fullPrompt[0]);
          if (validPrompt) return Decoration.none;
        }

        const from = line.from + openerStart;
        const to = line.from + forwardEnd;
        if (to <= from) return Decoration.none;
        if (insideCode(state, from)) return Decoration.none;

        return Decoration.set([
          Decoration.mark({ class: 'cm-macro-typing' }).range(from, to),
        ]);
      }
    },
    { decorations: v => v.decorations },
  );
}

// makeCoolingPlugin emits a Decoration.mark over each range in coolingField.
// The mark spec is reused across builds so CodeMirror keeps the same span
// element for the duration of the fade — that's what lets the CSS animation
// actually run to completion instead of restarting on every transaction.
const COOLING_MARK = Decoration.mark({ class: 'cm-macro-cooling' });

function makeCoolingPlugin() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        const prev = u.startState.field(coolingField, false);
        const next = u.state.field(coolingField, false);
        if (prev !== next || u.viewportChanged) {
          this.decorations = this.build(u.view);
        }
      }
      build(view: EditorView): DecorationSet {
        const cooling = view.state.field(coolingField, false);
        if (!cooling || cooling.size === 0) return Decoration.none;
        const ranges: Range<Decoration>[] = [];
        // Mark.range requires ascending order; sort by from.
        const entries = [...cooling.values()].sort((a, b) => a.from - b.from);
        for (const r of entries) {
          if (r.from >= r.to) continue;
          ranges.push(COOLING_MARK.range(r.from, r.to));
        }
        return Decoration.set(ranges, true);
      }
    },
    { decorations: v => v.decorations },
  );
}

function makeMacroOverlayPlugin() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        const prev = u.startState.field(activeMacrosField, false);
        const next = u.state.field(activeMacrosField, false);
        if (prev !== next || u.docChanged || u.viewportChanged) {
          this.decorations = this.build(u.view);
        }
      }
      build(view: EditorView): DecorationSet {
        const active = view.state.field(activeMacrosField, false);
        if (!active || active.size === 0) return Decoration.none;
        const ranges: Range<Decoration>[] = [];
        for (const [id, r] of active) {
          if (r.from >= r.to) continue;
          ranges.push(
            Decoration.replace({
              widget: new MacroDotsWidget(id, r.to - r.from, r.width),
            }).range(r.from, r.to),
          );
        }
        return Decoration.set(ranges, true);
      }
    },
    { decorations: v => v.decorations },
  );
}

export function buildMacroExtension(hooks: MacroHooks): Extension {
  return [
    activeMacrosField,
    streamingMacrosField,
    coolingField,
    makeMacroDetectorPlugin(hooks),
    makeMacroTypingPlugin(hooks),
    makeMacroOverlayPlugin(),
    makeCoolingPlugin(),
  ];
}
