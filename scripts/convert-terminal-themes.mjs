#!/usr/bin/env node
/**
 * Convert macOS Terminal.app `.terminal` profiles into the app's theme
 * registry (src/lib/terminal-themes.ts).
 *
 * Usage:
 *   node scripts/convert-terminal-themes.mjs <dir-with-.terminal-files>
 *
 * Source of the bundled set: https://github.com/lysyi3m/macos-terminal-themes
 * (MIT). Each profile is an XML plist whose color values are NSKeyedArchiver
 * blobs; the NSColor components are embedded as an ASCII float string
 * ("0.12 0.34 0.56") which is what we extract — no plist library needed.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

const [, , srcDir] = process.argv;
if (!srcDir) {
  console.error("usage: convert-terminal-themes.mjs <dir>");
  process.exit(1);
}

/** Map .terminal plist keys → xterm ITheme keys. */
const KEY_MAP = {
  BackgroundColor: "background",
  TextColor: "foreground",
  CursorColor: "cursor",
  SelectionColor: "selectionBackground",
  ANSIBlackColor: "black",
  ANSIRedColor: "red",
  ANSIGreenColor: "green",
  ANSIYellowColor: "yellow",
  ANSIBlueColor: "blue",
  ANSIMagentaColor: "magenta",
  ANSICyanColor: "cyan",
  ANSIWhiteColor: "white",
  ANSIBrightBlackColor: "brightBlack",
  ANSIBrightRedColor: "brightRed",
  ANSIBrightGreenColor: "brightGreen",
  ANSIBrightYellowColor: "brightYellow",
  ANSIBrightBlueColor: "brightBlue",
  ANSIBrightMagentaColor: "brightMagenta",
  ANSIBrightCyanColor: "brightCyan",
  ANSIBrightWhiteColor: "brightWhite",
};

function decodeColor(b64) {
  const ascii = Buffer.from(b64.replace(/\s+/g, ""), "base64").toString(
    "latin1",
  );
  // NSRGB ("r g b( a)?") or NSWhite ("w( a)?") components as ASCII floats.
  const m = ascii.match(/(\d(?:\.\d+)?)( \d(?:\.\d+)?){0,3}/);
  if (!m) return null;
  const parts = m[0].trim().split(" ").map(Number);
  let r, g, b;
  if (parts.length >= 3) [r, g, b] = parts;
  else r = g = b = parts[0]; // grayscale
  const hex = (v) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`.toUpperCase();
}

function parseProfile(path) {
  const xml = readFileSync(path, "utf8");
  const out = {};
  const re = /<key>([^<]+)<\/key>\s*<data>([\s\S]*?)<\/data>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const mapped = KEY_MAP[m[1]];
    if (!mapped) continue;
    const hex = decodeColor(m[2]);
    if (hex) out[mapped] = hex;
  }
  const nm = xml.match(/<key>name<\/key>\s*<string>([^<]+)<\/string>/);
  out.__name = nm ? nm[1] : basename(path, ".terminal");
  return out;
}

const themes = [];
for (const file of readdirSync(srcDir)) {
  if (!file.endsWith(".terminal")) continue;
  try {
    const t = parseProfile(join(srcDir, file));
    // A usable theme needs at least a background, text color and the
    // 8 normal ANSI colors.
    const required = [
      "background",
      "foreground",
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
    ];
    if (!required.every((k) => t[k])) {
      console.warn(`skip (incomplete): ${file}`);
      continue;
    }
    // Fill gaps: bright set falls back to the normal set, cursor to the
    // text color.
    for (const c of ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"]) {
      const bright = `bright${c}`;
      if (!t[bright]) t[bright] = t[c.toLowerCase()];
    }
    if (!t.cursor) t.cursor = t.foreground;
    const { __name, ...colors } = t;
    themes.push({ name: __name, ...colors });
  } catch (e) {
    console.warn(`skip (parse error): ${file}: ${e}`);
  }
}

themes.sort((a, b) => a.name.localeCompare(b.name));

const header = `/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node scripts/convert-terminal-themes.mjs <themes-dir>
 * Source: https://github.com/lysyi3m/macos-terminal-themes (MIT)
 */

export interface TerminalThemeEntry {
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export const TERMINAL_THEMES: TerminalThemeEntry[] = `;

writeFileSync(
  "src/lib/terminal-themes.ts",
  header + JSON.stringify(themes, null, 1) + ";\n",
);
console.log(`wrote ${themes.length} themes to src/lib/terminal-themes.ts`);
