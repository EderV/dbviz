import { useEffect, useMemo, useRef, useState } from 'react';
import jbMono400 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url';
import jbMono600 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2?url';
import plex400 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2?url';
import plex600 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2?url';
import { download } from '../../export/project';
import { embeddedFontCss, exportSvg, svgToPng } from '../../export/svgExport';
import type { ColumnMode } from '../../layout/types';
import { THEMES } from '../../render/theme';
import { search, type SearchHit } from '../../view/graphQueries';
import { useApp } from '../state/store';
import { useVisibleSet } from './Diagram';

const examples = import.meta.glob('/fixtures/*.sql', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;

export function Toolbar() {
  const generate = useApp((s) => s.generate);
  const status = useApp((s) => s.status);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const opts = useApp((s) => s.layoutOptions);
  const setLayoutOptions = useApp((s) => s.setLayoutOptions);
  const autoLayout = useApp((s) => s.autoLayout);
  const requestFit = useApp((s) => s.requestFit);
  const hasLayout = useApp((s) => !!s.layout);
  const fileInput = useRef<HTMLInputElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const visible = useVisibleSet();

  const onFile = async (file: File) => {
    const text = await file.text();
    if (file.name.endsWith('.json')) {
      try {
        useApp.getState().importProject(text);
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      }
    } else useApp.getState().loadSql(text, file.name);
  };

  const doExport = async (kind: 'svg' | 'png' | 'json') => {
    setExportOpen(false);
    const s = useApp.getState();
    const base = s.docName.replace(/\.(sql|json)$/i, '') || 'diagram';
    if (kind === 'json') return download(`${base}.dbviz.json`, s.exportProject(), 'application/json');
    if (!s.layout || !s.parse) return;
    const fontCss = await embeddedFontCss([
      { family: 'JetBrains Mono', weight: 400, url: jbMono400 },
      { family: 'JetBrains Mono', weight: 600, url: jbMono600 },
      { family: 'IBM Plex Sans', weight: 400, url: plex400 },
      { family: 'IBM Plex Sans', weight: 600, url: plex600 },
    ]);
    const out = exportSvg({ model: s.parse.model, layout: s.layout, positions: s.positions, theme: THEMES[s.theme], visible, fontCss });
    if (kind === 'svg') return download(`${base}.svg`, out.svg, 'image/svg+xml');
    download(`${base}.png`, await svgToPng(out.svg, out.width, out.height));
  };

  return (
    <header className="toolbar">
      <div className="brand" title="dbviz — local PostgreSQL schema diagrams">
        <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden>
          <rect x="3" y="5" width="11" height="9" rx="2" fill="var(--accent)" />
          <rect x="18" y="18" width="11" height="9" rx="2" fill="var(--edge)" />
          <path d="M14 9.5h4v13" stroke="var(--edge)" strokeWidth="2" fill="none" />
        </svg>
        <span>dbviz</span>
      </div>

      <button className="btn primary" onClick={generate} disabled={status === 'working'} title="Generate diagram (Ctrl/⌘ + Enter)">
        {status === 'working' ? <span className="spinner small" /> : null} Generate
      </button>
      <button className="btn" onClick={() => fileInput.current?.click()} title="Open a .sql file or a .dbviz.json project">
        Open…
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".sql,.txt,.json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          e.target.value = '';
        }}
      />
      <select
        className="select"
        value=""
        title="Load an example schema"
        onChange={async (e) => {
          const key = e.target.value;
          if (!key) return;
          const text = await examples[key]();
          useApp.getState().loadSql(text, key.split('/').pop()!);
        }}
      >
        <option value="">Examples</option>
        {Object.keys(examples)
          .sort()
          .map((k) => (
            <option key={k} value={k}>
              {k.split('/').pop()!.replace(/\.sql$/, '')}
            </option>
          ))}
      </select>

      <span className="sep" />
      <SearchBox />
      <span className="grow" />

      <div className="seg" role="group" title="Columns shown on cards">
        {(['all', 'keys', 'none'] as ColumnMode[]).map((m) => (
          <button key={m} className={opts.columnMode === m ? 'on' : ''} onClick={() => setLayoutOptions({ columnMode: m })} disabled={!hasLayout}>
            {m === 'all' ? 'All cols' : m === 'keys' ? 'Keys' : 'Names'}
          </button>
        ))}
      </div>
      <div className="seg" role="group" title="Spacing">
        {(['comfortable', 'compact'] as const).map((d) => (
          <button key={d} className={opts.density === d ? 'on' : ''} onClick={() => setLayoutOptions({ density: d })} disabled={!hasLayout}>
            {d === 'comfortable' ? 'Airy' : 'Dense'}
          </button>
        ))}
      </div>
      <button className="btn" onClick={autoLayout} disabled={!hasLayout} title="Re-run automatic layout (clears manual positions)">
        Auto layout
      </button>
      <button className="btn icon" onClick={requestFit} disabled={!hasLayout} title="Fit to screen (F)">
        ⤢
      </button>
      <div className="menu">
        <button className="btn" onClick={() => setExportOpen((o) => !o)} disabled={!hasLayout}>
          Export ▾
        </button>
        {exportOpen && (
          <div className="menu-pop" onMouseLeave={() => setExportOpen(false)}>
            <button onClick={() => doExport('png')}>PNG image</button>
            <button onClick={() => doExport('svg')}>SVG vector</button>
            <button onClick={() => doExport('json')}>Project (.dbviz.json)</button>
          </div>
        )}
      </div>
      <button className="btn icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle theme">
        {theme === 'dark' ? '☀' : '☾'}
      </button>
    </header>
  );
}

function SearchBox() {
  const model = useApp((s) => s.parse?.model);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => (model ? search(model, q) : []), [model, q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === '/' && !target.closest('.cm-editor, input, textarea, select')) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (h: SearchHit) => {
    useApp.getState().select(h.table, true, h.column);
    setOpen(false);
  };

  return (
    <div className="search">
      <input
        ref={input}
        placeholder="Search tables & columns  /"
        value={q}
        disabled={!model}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(hits.length - 1, a + 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
          else if (e.key === 'Enter' && hits[active]) pick(hits[active]);
          else if (e.key === 'Escape') {
            setQ('');
            input.current?.blur();
          } else return;
          e.preventDefault();
        }}
      />
      {open && hits.length > 0 && (
        <div className="search-pop">
          {hits.map((h, i) => (
            <button key={`${h.table}|${h.column ?? ''}`} className={i === active ? 'active' : ''} onMouseDown={() => pick(h)} onMouseEnter={() => setActive(i)}>
              <span className={`kind ${h.kind}`}>{h.kind === 'table' ? 'T' : 'C'}</span>
              <span className="label">{h.label}</span>
              <span className="detail">{h.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
