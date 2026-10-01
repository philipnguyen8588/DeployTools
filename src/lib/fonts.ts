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
