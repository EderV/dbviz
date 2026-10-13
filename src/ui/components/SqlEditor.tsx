import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, highlightActiveLine, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';
import type { Diagnostic } from '../../parser/types';
import { useApp } from '../state/store';

const setDiagnostics = StateEffect.define<Diagnostic[]>();

/** Error/warning line marks + an underline at the exact error column. */
const diagnosticsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setDiagnostics)) continue;
      const b = new RangeSetBuilder<Decoration>();
      const doc = tr.state.doc;
      const sorted = [...e.value].filter((d) => d.line >= 1 && d.line <= doc.lines).sort((a, z) => a.line - z.line || a.column - z.column);
      const seen = new Set<number>();
      for (const d of sorted) {
        const line = doc.line(d.line);
        if (seen.has(d.line)) continue;
        seen.add(d.line);
        b.add(line.from, line.from, Decoration.line({ class: `cm-diag-${d.severity}`, attributes: { title: d.message } }));
        if (d.severity === 'error') {
          const from = Math.min(line.to, line.from + Math.max(0, d.column - 1));
          const to = Math.min(line.to, from + Math.max(1, (/^[\w"$.]+/.exec(line.text.slice(from - line.from))?.[0].length ?? 1)));
          if (to > from) b.add(from, to, Decoration.mark({ class: 'cm-diag-mark' }));
        }
      }
      deco = b.finish();
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--cm-keyword)', fontWeight: '500' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--cm-type)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--cm-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--cm-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--ink-faint)', fontStyle: 'italic' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--ink-muted)' },
  { tag: tags.special(tags.name), color: 'var(--cm-quoted)' },
]);

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'transparent', color: 'var(--ink)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--ink-faint)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent) !important' },
  '.cm-content': { caretColor: 'var(--accent)' },
});

export function SqlEditor() {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  const diagnostics = useApp((s) => s.parse?.diagnostics);
  const sqlText = useApp((s) => s.sql);
  const jump = useApp((s) => s.editorJump);

  useEffect(() => {
    const { setSql, generate } = useApp.getState();
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: useApp.getState().sql,
        extensions: [
          lineNumbers(),
          history(),
          highlightActiveLine(),
          bracketMatching(),
          search({ top: true }),
          highlightSelectionMatches(),
          sql({ dialect: PostgreSQL }),
          syntaxHighlighting(highlight),
          diagnosticsField,
          editorTheme,
          keymap.of([
            { key: 'Mod-Enter', preventDefault: true, run: () => (generate(), true) },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setSql(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, []);

  // External document replacement (file upload, example, project import).
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === sqlText) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: sqlText } });
  }, [sqlText]);

  useEffect(() => {
    view.current?.dispatch({ effects: setDiagnostics.of(diagnostics ?? []) });
  }, [diagnostics]);

  useEffect(() => {
    const v = view.current;
    if (!v || !jump) return;
    const pos = Math.min(jump.offset, v.state.doc.length);
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    v.focus();
  }, [jump]);

  return <div className="sql-editor" ref={host} />;
}
