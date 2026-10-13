import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { THEMES, themeCssVars } from '../render/theme';
import { Diagram } from './components/Diagram';
import { DiagnosticsPanel, Inspector, SchemaPanel, StatusBar } from './components/Panels';
import { SqlEditor } from './components/SqlEditor';
import { Toolbar } from './components/Toolbar';
import { useApp } from './state/store';

export function App() {
  const theme = useApp((s) => s.theme);
  const mobileTab = useApp((s) => s.mobileTab);
  const setMobileTab = useApp((s) => s.setMobileTab);
  const hasModel = useApp((s) => !!s.parse);
  const inspectorOpen = useApp((s) => s.inspectorOpen && !!s.selected);
  const [split, setSplit] = useState(() => Math.round(Math.min(520, window.innerWidth * 0.32)));
  const [dragOver, setDragOver] = useState(false);
  const dragging = useRef(false);

  useEffect(() => {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(themeCssVars(THEMES[theme]))) root.style.setProperty(k, v);
    root.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.cm-editor, input, textarea, select')) return;
      if (e.key === 'Escape') useApp.getState().select(null);
      if (e.key === 'f' || e.key === 'F') useApp.getState().requestFit();
    };
    const move = (e: PointerEvent) => {
      if (dragging.current) setSplit(Math.max(260, Math.min(window.innerWidth - 360, e.clientX)));
    };
    const up = () => {
      dragging.current = false;
      document.body.classList.remove('resizing');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  return (
    <ReactFlowProvider>
      <div
        className={`app tab-${mobileTab}${dragOver ? ' drag-over' : ''}`}
        style={{ ['--split' as string]: `${split}px` }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOver(false);
        }}
        onDrop={async (e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files[0];
          if (!f) return;
          const text = await f.text();
          if (f.name.endsWith('.json')) useApp.getState().importProject(text);
          else useApp.getState().loadSql(text, f.name);
        }}
      >
        <Toolbar />
        <nav className="mobile-tabs">
          <button className={mobileTab === 'sql' ? 'on' : ''} onClick={() => setMobileTab('sql')}>
            SQL
          </button>
          <button className={mobileTab === 'diagram' ? 'on' : ''} onClick={() => setMobileTab('diagram')}>
            Diagram
          </button>
        </nav>
        <main className="workspace">
          <aside className="left">
            <div className="editor-wrap">
              <SqlEditor />
            </div>
            <DiagnosticsPanel />
          </aside>
          <div
            className="splitter"
            onPointerDown={() => {
              dragging.current = true;
              document.body.classList.add('resizing');
            }}
            title="Drag to resize"
          />
          <section className="canvas">
            <Diagram />
            {hasModel && (
              <div className="float-left">
                <SchemaPanel />
              </div>
            )}
            {inspectorOpen && (
              <div className="float-right">
                <Inspector />
              </div>
            )}
          </section>
        </main>
        <StatusBar />
        {dragOver && <div className="drop-hint">Drop a .sql file or .dbviz.json project</div>}
      </div>
    </ReactFlowProvider>
  );
}
