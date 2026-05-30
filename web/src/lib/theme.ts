/**
 * Theme system — Phase 6.B.
 *
 * The CSS in src/index.css uses CSS custom properties for every color
 * (--bg, --accent, --surface, etc.). A "theme" is just a set of values
 * to override on :root.
 *
 * Application strategy:
 *   1. On boot (before React renders), read the saved theme from
 *      localStorage and apply it to document.documentElement.style.
 *      Done synchronously to avoid a flash of the default palette.
 *   2. The Settings page exposes a switcher that calls applyTheme()
 *      and persists the new choice.
 *   3. Themes only override a small set of variables; everything else
 *      cascades from the base index.css. Adding a new theme = add a
 *      new entry to THEMES.
 *
 * Storage key is namespaced (`hermes-van:theme`) and version-tagged so
 * a future format change can detect and reset cleanly.
 */
export const THEME_STORAGE_KEY = "hermes-van:theme:v1";

export type ThemeId =
  | "dark-enterprise"
  | "hermes-green"
  | "oled-pure"
  | "solarized-dark";

export interface Theme {
  id: ThemeId;
  label: string;
  /** Short description for the picker UI. */
  blurb: string;
  /** CSS variable overrides applied to :root. Keys must include leading "--". */
  vars: Record<string, string>;
}

export const THEMES: readonly Theme[] = [
  {
    id: "dark-enterprise",
    label: "Dark Enterprise",
    blurb: "Default. Charcoal grid + cool blue accent.",
    vars: {
      "--bg": "#050505",
      "--bg-elev": "#0c0c0c",
      "--surface": "#111111",
      "--surface-2": "#161616",
      "--border": "#1f1f1f",
      "--border-strong": "#2a2a2a",
      "--text": "#e8e8e8",
      "--text-muted": "#8a8a8a",
      "--text-dim": "#5a5a5a",
      "--accent": "#6e8eff",
      "--accent-dim": "#3a4a8a",
    },
  },
  {
    id: "hermes-green",
    label: "Hermes Green",
    blurb: "Same chrome, terminal-green accent (nods to the gateway).",
    vars: {
      "--accent": "#22c55e",
      "--accent-dim": "#15803d",
    },
  },
  {
    id: "oled-pure",
    label: "OLED Pure",
    blurb: "True-black background — saves power on OLED displays.",
    vars: {
      "--bg": "#000000",
      "--bg-elev": "#070707",
      "--surface": "#0c0c0c",
      "--surface-2": "#121212",
      "--border": "#1a1a1a",
      "--border-strong": "#262626",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    blurb: "Ethan Schoonover's classic. Warm base, cyan-yellow accent.",
    vars: {
      "--bg": "#002b36",
      "--bg-elev": "#073642",
      "--surface": "#0a4250",
      "--surface-2": "#0e4d5d",
      "--border": "#11556a",
      "--border-strong": "#1a6378",
      "--text": "#eee8d5",
      "--text-muted": "#93a1a1",
      "--text-dim": "#586e75",
      "--accent": "#b58900",
      "--accent-dim": "#7a5c00",
    },
  },
] as const;

export const DEFAULT_THEME_ID: ThemeId = "dark-enterprise";

export function getTheme(id: ThemeId): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

/**
 * Pull the saved theme id from storage. Returns the default if storage
 * is unreachable (SSR, private mode) or the stored value isn't a known
 * theme. Pure for tests — caller passes its own storage shim.
 */
export function readThemeId(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null,
): ThemeId {
  if (!storage) return DEFAULT_THEME_ID;
  let raw: string | null = null;
  try {
    raw = storage.getItem(THEME_STORAGE_KEY);
  } catch {
    return DEFAULT_THEME_ID;
  }
  if (!raw) return DEFAULT_THEME_ID;
  if (THEMES.some((t) => t.id === raw)) return raw as ThemeId;
  return DEFAULT_THEME_ID;
}

/**
 * Apply a theme by writing each variable onto the supplied element's
 * inline style. Applying onto document.documentElement (default) makes
 * the override beat :root in the cascade with the same specificity but
 * later in source order.
 */
export function applyTheme(
  id: ThemeId,
  el: { style: { setProperty: (k: string, v: string) => void } } | null = typeof document !==
    "undefined"
    ? document.documentElement
    : null,
): void {
  if (!el) return;
  const theme = getTheme(id);
  // First, reset every var we know about across all themes so switching
  // to a sparse theme (like hermes-green) doesn't leave residual vars
  // from a previous theme (like solarized-dark) sticking around.
  const allKeys = new Set<string>();
  for (const t of THEMES) for (const k of Object.keys(t.vars)) allKeys.add(k);
  for (const k of allKeys) el.style.setProperty(k, "");
  // Then apply this theme's overrides.
  for (const [k, v] of Object.entries(theme.vars)) {
    el.style.setProperty(k, v);
  }
}

/**
 * Persist + apply in one call. Tolerates storage failures.
 */
export function setTheme(id: ThemeId): void {
  applyTheme(id);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(THEME_STORAGE_KEY, id);
    }
  } catch {
    // private mode / quota — apply still wins, just no persistence.
  }
  // Also reflect on the meta theme-color so the OS chrome (PWA splash,
  // mobile browser UI) matches the active theme's bg color.
  const bg = getTheme(id).vars["--bg"];
  if (typeof document !== "undefined" && bg) {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = bg;
  }
}

/**
 * Boot helper — call once before React renders. Reads the saved theme
 * (default if none) and applies it synchronously so the very first
 * paint already shows the right colors.
 */
export function bootTheme(): ThemeId {
  const id = readThemeId();
  applyTheme(id);
  return id;
}
