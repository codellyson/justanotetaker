import { useEffect, useRef } from "react";
import {
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { EditorState, type Range } from "@codemirror/state";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage, markdownKeymap } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { tags as t } from "@lezer/highlight";

// Render markdown formatting live: headings grow, bold/italic/code style up.
// Colours come from the app's CSS vars so it tracks the light/dark theme.
const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.25em", fontWeight: "650", lineHeight: "1.25" },
  { tag: t.heading2, fontSize: "1.12em", fontWeight: "650", lineHeight: "1.25" },
  { tag: t.heading3, fontSize: "1.02em", fontWeight: "650" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "650" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "rgb(var(--text-muted))" },
  { tag: t.monospace, fontFamily: "var(--font-jn-mono), ui-monospace, monospace", fontSize: "0.92em" },
  { tag: [t.link, t.url], color: "rgb(var(--accent))", textDecoration: "underline" },
  { tag: t.quote, color: "rgb(var(--text-secondary))", fontStyle: "italic" },
  { tag: t.list, color: "rgb(var(--text-secondary))" },
  { tag: t.processingInstruction, color: "rgb(var(--text-muted))" },
]);

// Obsidian-style live preview: the syntax marks (#, **, `, ~~) are hidden
// unless the caret sits on that line, so you read the formatted result while
// still editing plain markdown text.
const HIDE = Decoration.replace({});
const MARK_NODES = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "StrikethroughMark",
]);

function buildLivePreview(view: EditorView): DecorationSet {
  const { state } = view;
  const activeLines = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let ln = a; ln <= b; ln++) activeLines.add(ln);
  }

  const marks: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (!MARK_NODES.has(node.name)) return;
        const line = state.doc.lineAt(node.from);
        if (activeLines.has(line.number)) return;
        // Swallow the space after `#` too, so a hidden heading mark doesn't
        // leave the title indented by a stray leading space.
        let end = node.to;
        if (node.name === "HeaderMark") {
          while (end < line.to && state.doc.sliceString(end, end + 1) === " ") end++;
        }
        marks.push(HIDE.range(node.from, end));
      },
    });
  }
  return Decoration.set(marks, true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildLivePreview(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildLivePreview(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "inherit" },
  "&.cm-focused": { outline: "none" },
  // Font + leading are inherited from the note card so the editor matches each
  // surface (default sans, paper serif) without the editor overriding them.
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "inherit",
    overflow: "auto",
  },
  ".cm-content": { padding: "0", caretColor: "rgb(var(--accent))" },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "rgb(var(--accent))" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "rgb(var(--accent) / 0.22)",
  },
  ".cm-placeholder": { color: "rgb(var(--text-muted))" },
});

export default function CmEditor({
  value,
  onChange,
  onCommit,
  autoFocus = true,
  placeholder = "just write.",
  className,
  clickPos,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
  // Viewport point of the click that opened the editor, so the caret lands
  // where the user clicked instead of jumping to the end of the text.
  clickPos?: { x: number; y: number } | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onCommitRef = useRef(onCommit);
  onChangeRef.current = onChange;
  onCommitRef.current = onCommit;

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        keymap.of([
          { key: "Mod-Enter", run: () => (onCommitRef.current(), true) },
          { key: "Escape", run: () => (onCommitRef.current(), true) },
          ...markdownKeymap,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        markdown({ base: markdownLanguage, extensions: GFM }),
        syntaxHighlighting(mdHighlight),
        livePreview,
        EditorView.lineWrapping,
        cmPlaceholder(placeholder),
        editorTheme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    // Focus + caret placement is deferred one frame. On a re-edit the editor
    // mounts synchronously with the click, so doing this now would (a) read
    // stale geometry in posAtCoords — the card is still reflowing from the
    // rendered markdown to the editor — and (b) lose the focus race with the
    // browser's own click handling, leaving the caret invisible. One rAF lands
    // it after the reflow and after the click settles, on every mount.
    let raf = 0;
    if (autoFocus) {
      raf = requestAnimationFrame(() => {
        if (viewRef.current !== view) return;
        // preventScroll: focusing an off-screen card otherwise scrolls it into
        // view and cancels the in-flight fly-to-note pan/zoom.
        view.contentDOM.focus({ preventScroll: true });
        // Place the caret at the click point when we have one (a card click).
        // `false` snaps to the nearest position rather than returning null when
        // the click lands just off the editor's line (the rendered view the
        // user clicked and the editor's layout don't line up exactly).
        const at = clickPos ? view.posAtCoords(clickPos, false) : null;
        view.dispatch({ selection: { anchor: at ?? view.state.doc.length } });
      });
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
      view.destroy();
      viewRef.current = null;
    };
    // Editor is created once; external value changes are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile an external text change (e.g. an agent edit) into the editor,
  // guarding against the echo of our own updateListener → onChange → value.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (value !== cur) {
      view.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className={className} onKeyDown={(e) => e.stopPropagation()} />;
}
