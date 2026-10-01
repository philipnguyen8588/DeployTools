/**
 * User-imported terminal fonts.
 *
 * Files live in `<vault dir>/fonts/` (copied there by the backend so the
 * user's normal vault backup covers them). This module reads them back as
 * base64 and registers them with the FontFace API so xterm can use them.
 *
 * Family/weight/style are derived from the FILE NAME, following the
 * near-universal `Family-StyleModifier.ext` convention — importing
 * `SFMono-Regular.otf`, `SFMono-Bold.otf`, `SFMono-RegularItalic.otf`
 * yields ONE family "SFMono" with proper bold/italic faces, exactly what
 * xterm needs for bold prompts and italic output.
 */
import * as api from "@/lib/api";
import type { FontEntry } from "@/lib/types";

export interface FontMeta {
  family: string;
  /** CSS weight 100–900. */
  weight: number;
  style: "normal" | "italic";
  fileName: string;
}

const WEIGHT_WORDS: [string, number][] = [
  // Longest first so "extralight" wins over "light".
  ["extralight", 200],
  ["ultralight", 200],
  ["extrabold", 800],
  ["ultrabold", 800],
  ["semibold", 600],
  ["demibold", 600],
  ["regular", 400],
  ["normal", 400],
  ["medium", 500],
  ["heavy", 900],
  ["black", 900],
  ["light", 300],
  ["thin", 100],
  ["bold", 700],
  ["book", 400],
];

/** Derive {family, weight, style} from a font file name. */
export function parseFontMeta(fileName: string): FontMeta {
  const stem = fileName.replace(/\.[^.]+$/, "");
  // Split "Family-Modifiers"; no dash → whole stem is the family.
  const dash = stem.lastIndexOf("-");
  const familyRaw = dash > 0 ? stem.slice(0, dash) : stem;
  let modifiers = (dash > 0 ? stem.slice(dash + 1) : "").toLowerCase();

  let style: FontMeta["style"] = "normal";
  if (modifiers.includes("italic") || modifiers.includes("oblique")) {
    style = "italic";
    modifiers = modifiers.replace(/italic|oblique/g, "");
  }
  let weight = 400;
  for (const [word, w] of WEIGHT_WORDS) {
    if (modifiers.includes(word)) {
      weight = w;
      break;
    }
  }
  return { family: familyRaw, weight, style, fileName };
}

/** Files already registered with document.fonts this session. */
const registered = new Set<string>();

async function registerFont(entry: FontEntry): Promise<void> {
  if (registered.has(entry.file_name)) return;
  const meta = parseFontMeta(entry.file_name);
  const b64 = await api.fontRead(entry.file_name);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const face = new FontFace(meta.family, bytes.buffer, {
    weight: String(meta.weight),
    style: meta.style,
  });
  await face.load();
  document.fonts.add(face);
  registered.add(entry.file_name);
}

/**
 * Load every imported font into the webview. Idempotent — call freely
 * (app start, after an import). Individual failures are logged, not
 * thrown, so one corrupt file can't block the rest.
 */
export async function ensureFontsLoaded(): Promise<FontEntry[]> {
  const entries = await api.fontList();
  await Promise.all(
    entries.map((e) =>
      registerFont(e).catch((err) => {
        console.warn(`font ${e.file_name} failed to load:`, err);
      }),
    ),
  );
  return entries;
}

/** Unique family names among the given imported files. */
export function familiesOf(entries: FontEntry[]): string[] {
  const set = new Set(entries.map((e) => parseFontMeta(e.file_name).family));
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// Free terminal-font catalog — all OFL/libre, downloaded on demand from the
// Fontsource CDN into the same fonts/ folder as manual imports (so the
// vault backup covers them and nothing is bundled with the app).
// ---------------------------------------------------------------------------

export interface CatalogFace {
  weight: number;
  italic?: boolean;
}

export interface CatalogFont {
  /** Display name in the picker. */
  label: string;
  /** File-name prefix AND resulting CSS family (no spaces). */
  family: string;
  /** Fontsource package id (cdn.jsdelivr.net/fontsource/fonts/<id>@latest). */
  id: string;
  /** Faces worth having in a terminal (body weights + bold + italics). */
  faces: CatalogFace[];
  /** Short hook shown next to the name. */
  note?: string;
}

const RGB: CatalogFace[] = [{ weight: 400 }, { weight: 700 }];
const LRGB: CatalogFace[] = [{ weight: 300 }, { weight: 400 }, { weight: 700 }];
const withItalics = (faces: CatalogFace[]): CatalogFace[] => [
  ...faces,
  ...faces.map((f) => ({ ...f, italic: true })),
];

export const FONT_CATALOG: CatalogFont[] = [
  { label: "Fira Code", family: "FiraCode", id: "fira-code", faces: LRGB, note: "ligatures" },
  // Fontsource ships Hack without italics — upright faces only.
  { label: "Hack", family: "Hack", id: "hack", faces: RGB, note: "classic terminal" },
  { label: "Source Code Pro", family: "SourceCodePro", id: "source-code-pro", faces: withItalics(LRGB), note: "Adobe" },
  { label: "IBM Plex Mono", family: "IBMPlexMono", id: "ibm-plex-mono", faces: withItalics(LRGB), note: "IBM" },
  { label: "Roboto Mono", family: "RobotoMono", id: "roboto-mono", faces: withItalics(LRGB), note: "Google" },
  { label: "Ubuntu Mono", family: "UbuntuMono", id: "ubuntu-mono", faces: withItalics(RGB), note: "Ubuntu" },
  { label: "Inconsolata", family: "Inconsolata", id: "inconsolata", faces: LRGB, note: "compact" },
  { label: "Space Mono", family: "SpaceMono", id: "space-mono", faces: withItalics(RGB), note: "retro" },
  { label: "Victor Mono", family: "VictorMono", id: "victor-mono", faces: withItalics(LRGB), note: "cursive italics" },
  { label: "Anonymous Pro", family: "AnonymousPro", id: "anonymous-pro", faces: withItalics(RGB), note: "coding classic" },
  { label: "Geist Mono", family: "GeistMono", id: "geist-mono", faces: LRGB, note: "Vercel, UI-sans look" },
  { label: "Martian Mono", family: "MartianMono", id: "martian-mono", faces: LRGB, note: "wide & sturdy" },
];

function faceSuffix(f: CatalogFace): string {
  const w = f.weight === 300 ? "Light" : f.weight === 700 ? "Bold" : "Regular";
  return f.italic ? `${w}Italic` : w;
}

function faceUrl(id: string, f: CatalogFace): string {
  return `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-${f.weight}-${f.italic ? "italic" : "normal"}.woff2`;
}

/**
 * Download every face of a catalog font into the fonts dir and register
 * them. Individual face failures (e.g. a weight the CDN lacks) are
 * tolerated as long as at least one face lands.
 */
export async function downloadCatalogFont(font: CatalogFont): Promise<FontEntry[]> {
  let okAny = false;
  for (const face of font.faces) {
    const fileName = `${font.family}-${faceSuffix(face)}.woff2`;
    try {
      await api.fontDownload(faceUrl(font.id, face), fileName);
      okAny = true;
    } catch (e) {
      console.warn(`catalog face ${fileName} failed:`, e);
    }
  }
  if (!okAny) {
    throw new Error(`Could not download any face of ${font.label}`);
  }
  return ensureFontsLoaded();
}
