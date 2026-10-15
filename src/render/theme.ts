/**
 * Design tokens. Single source of truth: the app writes them to CSS custom
 * properties at runtime, and the SVG/PNG exporter reads them directly.
 *
 * The look is "drafting table": warm paper / graphite instead of pure white
 * or pure black, ink-blue relationships, and a single signal orange for
 * selection, so attention always lands on what the user picked.
 */
export interface ThemeTokens {
  bg: string;
  grid: string;
  panel: string;
  panelBorder: string;
  ink: string;
  inkMuted: string;
  inkFaint: string;
  card: string;
  cardBorder: string;
  cardHeader: string;
  rowHover: string;
  edge: string;
  edgeCross: string;
  accent: string;
  accentSoft: string;
  pk: string;
  fk: string;
  uq: string;
  /** Views: border, badge and title ink. */
  view: string;
  /** Views: header tint. */
  viewHeader: string;
  danger: string;
  warn: string;
  schemaFillAlpha: number;
  schemaStrokeAlpha: number;
  schemaLightness: number;
  schemaSaturation: number;
}

export const THEMES: Record<'light' | 'dark', ThemeTokens> = {
  light: {
    bg: '#f3f1ec',
    grid: '#e3dfd6',
    panel: '#fbfaf7',
    panelBorder: '#dcd7cc',
    ink: '#1f2328',
    inkMuted: '#5d646d',
    inkFaint: '#9aa0a6',
    card: '#ffffff',
    cardBorder: '#c9c4b8',
    cardHeader: '#f4f2ed',
    rowHover: '#f6efe6',
    edge: '#4a6a9e',
    edgeCross: '#8a5a9e',
    accent: '#e8590c',
    accentSoft: '#fde3d3',
    pk: '#b7791f',
    fk: '#3b6fb6',
    uq: '#2f855a',
    view: '#0e7c86',
    viewHeader: '#e3f2f2',
    danger: '#c53030',
    warn: '#b7791f',
    schemaFillAlpha: 0.07,
    schemaStrokeAlpha: 0.45,
    schemaLightness: 45,
    schemaSaturation: 45,
  },
  dark: {
    bg: '#14171a',
    grid: '#1e2226',
    panel: '#191d21',
    panelBorder: '#2a3036',
    ink: '#e4e6e8',
    inkMuted: '#a0a7ae',
    inkFaint: '#6b737b',
    card: '#1d2227',
    cardBorder: '#363d45',
    cardHeader: '#232a30',
    rowHover: '#2a2520',
    edge: '#7f9fd4',
    edgeCross: '#b48fd0',
    accent: '#ff8a3d',
    accentSoft: '#4a2a17',
    pk: '#e0b050',
    fk: '#79a8ea',
    uq: '#68c08f',
    view: '#4cc3cc',
    viewHeader: '#1b2e31',
    danger: '#f07070',
    warn: '#e0b050',
    schemaFillAlpha: 0.09,
    schemaStrokeAlpha: 0.5,
    schemaLightness: 62,
    schemaSaturation: 40,
  },
};

export const FONT_MONO = "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";
export const FONT_UI = "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";

export function schemaColors(t: ThemeTokens, hue: number) {
  // Plain rgb()/rgba(): understood by every SVG consumer, not just browsers.
  const [r, g, b] = hslToRgb(hue, t.schemaSaturation / 100, t.schemaLightness / 100);
  return {
    solid: `rgb(${r},${g},${b})`,
    fill: `rgba(${r},${g},${b},${t.schemaFillAlpha})`,
    stroke: `rgba(${r},${g},${b},${t.schemaStrokeAlpha})`,
  };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export function themeCssVars(t: ThemeTokens): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(t)) {
    if (typeof v === 'string') vars[`--${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`] = v;
  }
  return vars;
}
