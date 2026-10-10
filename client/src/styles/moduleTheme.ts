/**
 * Shared design system for federated modules.
 *
 * robin-admin owns the look & feel. Each module is mounted in its own Shadow
 * DOM, so the host's Tailwind never reaches in — instead this token +
 * component sheet is injected into every module's shadow root (see ModuleHost),
 * and the host stamps `data-theme="light|dark"` on the shadow host so the whole
 * palette flips with the app theme.
 *
 * Modules consume it by pointing their own CSS variables at `var(--ra-*)` and
 * using the `.ra-*` component classes. There is one source of truth for colour,
 * dark mode, radius and chrome; a module never hardcodes its own palette.
 */
export const MODULE_THEME_STYLE_ID = 'robin-admin-module-theme';

export const moduleThemeCss = `
:host {
  /* Accent (robin-orange) */
  --ra-accent: #FE8502;
  --ra-accent-hover: #EA580C;
  --ra-accent-contrast: #ffffff;
  --ra-accent-soft: rgba(254, 133, 2, 0.10);

  /* Semantic */
  --ra-success: #44A83A;
  --ra-success-soft: rgba(68, 168, 58, 0.12);
  --ra-danger: #DC2626;
  --ra-danger-soft: rgba(220, 38, 38, 0.10);
  --ra-warning: #D97706;
  --ra-warning-soft: rgba(217, 119, 6, 0.12);
  /* Neutral "info"/tag chip — replaces ad-hoc blues so nothing competes with the accent */
  --ra-neutral-soft: #f3f4f6;
  --ra-neutral-text: #4b5563;

  /* Surfaces (light) */
  --ra-bg: #ffffff;
  --ra-surface: #ffffff;
  --ra-surface-2: #f3f4f6;
  --ra-surface-hover: #e5e7eb;
  --ra-border: rgba(0, 0, 0, 0.10);

  /* Text (light) */
  --ra-text: #111827;
  --ra-text-muted: #6b7280;
  --ra-text-subtle: #9ca3af;

  /* Radii */
  --ra-radius: 0.25rem;
  --ra-radius-md: 0.375rem;
  --ra-radius-lg: 0.5rem;
  --ra-radius-xl: 0.75rem;
  --ra-radius-full: 9999px;

  --ra-shadow-card: 0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04);
  --ra-ring: 0 0 0 2px var(--ra-accent);

  --ra-font-sans: Arial, Helvetica, sans-serif;
  --ra-font-mono: Consolas, "Courier New", monospace;

  display: block;
  color-scheme: light;
  background: var(--ra-bg);
  color: var(--ra-text);
  font-family: var(--ra-font-sans);
  font-size: 14px;
  line-height: 1.5;
}

:host([data-theme="dark"]) {
  color-scheme: dark;
  --ra-accent-soft: rgba(254, 133, 2, 0.14);
  --ra-success-soft: rgba(68, 168, 58, 0.18);
  --ra-danger-soft: rgba(220, 38, 38, 0.16);
  --ra-warning-soft: rgba(217, 119, 6, 0.18);
  --ra-neutral-soft: #424146;
  --ra-neutral-text: #d1d5db;

  --ra-bg: #1a1a1a;
  --ra-surface: #2d2d2d;
  --ra-surface-2: #424146;
  --ra-surface-hover: #555555;
  --ra-border: rgba(255, 255, 255, 0.10);

  --ra-text: #f3f4f6;
  --ra-text-muted: #9ca3af;
  --ra-text-subtle: #6b7280;

  --ra-shadow-card: 0 1px 3px rgba(0, 0, 0, 0.4), 0 1px 2px rgba(0, 0, 0, 0.3);
}

/* Themed scrollbars for everything in the module subtree */
:host *, :host { scrollbar-width: thin; scrollbar-color: var(--ra-surface-hover) transparent; }
:host ::-webkit-scrollbar { width: 8px; height: 8px; }
:host ::-webkit-scrollbar-track { background: transparent; }
:host ::-webkit-scrollbar-thumb { background: var(--ra-surface-hover); border-radius: var(--ra-radius-full); border: 2px solid transparent; background-clip: padding-box; }

/* ---- Component classes (mirror the host) ---- */
.ra-card {
  background: var(--ra-surface);
  border: 1px solid var(--ra-border);
  border-radius: var(--ra-radius-xl);
  box-shadow: var(--ra-shadow-card);
}
.ra-card-body { padding: 1.5rem; }
.ra-card-header { padding: 1rem 1.5rem; border-bottom: 1px solid var(--ra-border); }
.ra-card-title { font-size: 1rem; font-weight: 600; letter-spacing: -0.01em; }

/* Tabs — match the host metrics tabs: moderate radius, solid orange active */
.ra-tabs { display: inline-flex; flex-wrap: wrap; gap: 0.5rem; }
.ra-tab {
  padding: 0.5rem 1rem;
  border: 0;
  border-radius: var(--ra-radius);
  font-weight: 500;
  font-size: 0.875rem;
  cursor: pointer;
  background: var(--ra-surface-2);
  color: var(--ra-text);
  transition: background-color .15s, color .15s;
}
.ra-tab:hover { background: var(--ra-surface-hover); }
.ra-tab[aria-selected="true"], .ra-tab.is-active {
  background: var(--ra-accent);
  color: var(--ra-accent-contrast);
}
.ra-tab:focus-visible { outline: 2px solid var(--ra-accent); outline-offset: 2px; }

.ra-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: .5rem;
  padding: .5rem 1rem; border: 0; border-radius: var(--ra-radius);
  font-weight: 500; cursor: pointer; transition: background-color .15s;
}
.ra-btn:disabled { opacity: .5; cursor: not-allowed; }
.ra-btn-primary { background: var(--ra-accent); color: var(--ra-accent-contrast); }
.ra-btn-primary:hover { background: var(--ra-accent-hover); }
.ra-btn-secondary { background: var(--ra-surface-2); color: var(--ra-text); }
.ra-btn-secondary:hover { background: var(--ra-surface-hover); }
.ra-btn-danger { background: var(--ra-danger); color: #fff; }
.ra-btn-success { background: var(--ra-success); color: #fff; }

.ra-input {
  width: 100%; padding: .5rem .75rem; border-radius: var(--ra-radius);
  background: var(--ra-surface); border: 1px solid var(--ra-border); color: var(--ra-text);
}
.ra-input:focus { outline: none; box-shadow: var(--ra-ring); border-color: transparent; }
.ra-label { display: block; font-size: .875rem; font-weight: 500; color: var(--ra-text-muted); margin-bottom: .25rem; }

.ra-table { width: 100%; border-collapse: collapse; }
.ra-table th { padding: .75rem 1rem; text-align: left; font-size: .875rem; font-weight: 600; background: var(--ra-surface-2); border-bottom: 1px solid var(--ra-border); }
.ra-table td { padding: .75rem 1rem; font-size: .875rem; vertical-align: top; border-bottom: 1px solid var(--ra-border); }
.ra-table tr:hover td { background: var(--ra-accent-soft); }

.ra-scroll { overflow: auto; }
.ra-muted { color: var(--ra-text-muted); }
.ra-subtle { color: var(--ra-text-subtle); }
`;
