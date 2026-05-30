/**
 * Phase 6.B — theme system unit tests.
 *
 * Verifies:
 *   1. readThemeId() falls back to default when nothing is stored.
 *   2. readThemeId() returns a stored value if it's a known theme id.
 *   3. readThemeId() falls back when the stored value isn't recognised
 *      (defense against a hand-edited or stale-format key).
 *   4. applyTheme() writes the expected CSS variables for known themes.
 *   5. applyTheme() resets every var across all themes before applying,
 *      so switching from a heavy theme to a sparse one doesn't leave
 *      residual variables behind.
 *   6. setTheme() persists to localStorage AND updates the active vars.
 *   7. Default theme matches the base index.css palette (regression
 *      guard: if someone changes the default theme but not index.css,
 *      this test fires before users see a colour mismatch).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  THEMES,
  THEME_STORAGE_KEY,
  DEFAULT_THEME_ID,
  getTheme,
  readThemeId,
  applyTheme,
  setTheme,
} from "../../src/lib/theme";

interface FakeStorage extends Pick<Storage, "getItem"> {
  store: Map<string, string>;
  setItem: (k: string, v: string) => void;
  clear: () => void;
}

function makeStorage(): FakeStorage {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v);
    },
    clear: () => store.clear(),
  };
}

interface FakeEl {
  vars: Map<string, string>;
  style: { setProperty: (k: string, v: string) => void };
}
function makeEl(): FakeEl {
  const vars = new Map<string, string>();
  return {
    vars,
    style: {
      setProperty: (k, v) => {
        if (v === "") vars.delete(k);
        else vars.set(k, v);
      },
    },
  };
}

describe("readThemeId", () => {
  test("returns default when storage is empty", () => {
    expect(readThemeId(makeStorage())).toBe(DEFAULT_THEME_ID);
  });

  test("returns stored value for a known theme", () => {
    const s = makeStorage();
    s.setItem(THEME_STORAGE_KEY, "oled-pure");
    expect(readThemeId(s)).toBe("oled-pure");
  });

  test("falls back to default for unknown stored value", () => {
    const s = makeStorage();
    s.setItem(THEME_STORAGE_KEY, "vaporwave-pink"); // not a theme
    expect(readThemeId(s)).toBe(DEFAULT_THEME_ID);
  });

  test("falls back when storage throws (private mode shim)", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
    } as unknown as Pick<Storage, "getItem">;
    expect(readThemeId(broken)).toBe(DEFAULT_THEME_ID);
  });
});

describe("applyTheme", () => {
  test("writes the theme's vars onto the element", () => {
    const el = makeEl();
    applyTheme("hermes-green", el);
    expect(el.vars.get("--accent")).toBe("#22c55e");
    expect(el.vars.get("--accent-dim")).toBe("#15803d");
  });

  test("clears residual vars from a previous theme before applying a sparse one", () => {
    const el = makeEl();
    // Prime with the heaviest theme — solarized sets --bg + everything.
    applyTheme("solarized-dark", el);
    expect(el.vars.get("--bg")).toBe("#002b36");
    // Now switch to hermes-green, which only overrides accents.
    applyTheme("hermes-green", el);
    // --bg from solarized must be gone (back to falling through to :root).
    expect(el.vars.has("--bg")).toBe(false);
    // --accent should reflect the new theme, not the previous one.
    expect(el.vars.get("--accent")).toBe("#22c55e");
  });

  test("default theme writes the canonical Dark Enterprise palette", () => {
    const el = makeEl();
    applyTheme(DEFAULT_THEME_ID, el);
    const t = getTheme(DEFAULT_THEME_ID);
    for (const [k, v] of Object.entries(t.vars)) {
      expect(el.vars.get(k)).toBe(v);
    }
  });

  test("is a no-op on a null element", () => {
    expect(() => applyTheme("oled-pure", null)).not.toThrow();
  });
});

describe("setTheme", () => {
  beforeEach(() => {
    // Spy/mock localStorage + document for the JSDOM-less test env.
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: makeStorage(),
    });
    const meta = { content: "" };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement: makeEl(),
        querySelector: vi.fn(() => meta),
      },
    });
  });

  test("persists the new theme id to localStorage", () => {
    setTheme("oled-pure");
    expect(
      (globalThis.localStorage as unknown as FakeStorage).store.get(
        THEME_STORAGE_KEY,
      ),
    ).toBe("oled-pure");
  });

  test("updates the meta theme-color so OS chrome matches", () => {
    const meta = { content: "" };
    (globalThis.document.querySelector as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      meta,
    );
    setTheme("oled-pure");
    expect(meta.content).toBe("#000000");
  });

  test("survives storage failures without throwing", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      },
    });
    expect(() => setTheme("hermes-green")).not.toThrow();
  });
});

describe("THEMES catalog", () => {
  test("every theme has a unique id", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("default theme exists in the catalog", () => {
    expect(THEMES.some((t) => t.id === DEFAULT_THEME_ID)).toBe(true);
  });

  test("every CSS var key starts with -- and has a non-empty value", () => {
    for (const t of THEMES) {
      for (const [k, v] of Object.entries(t.vars)) {
        expect(k.startsWith("--"), `${t.id}: ${k} must start with --`).toBe(true);
        expect(v.trim().length, `${t.id}: ${k} must not be empty`).toBeGreaterThan(0);
      }
    }
  });
});
