/**
 * Free terminal fonts BUNDLED with the app (all OFL/MIT — redistribution
 * is explicitly allowed, unlike Apple's SF Mono which must be imported
 * by the user from their own machine).
 *
 * Importing these css files only registers @font-face rules — the woff2
 * payloads are fetched lazily the first time a family is actually
 * rendered, so app startup cost is near zero and unused fonts never
 * load. Weights: 300/400/700 (+italics) where the font provides them;
 * when a face is missing (e.g. Hack has no italics) the browser falls
 * back to the nearest available one.
 */
import "@fontsource/fira-code/300.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/700.css";
import "hack-font/build/web/hack.css";
import "@fontsource/source-code-pro/300.css";
import "@fontsource/source-code-pro/300-italic.css";
import "@fontsource/source-code-pro/400.css";
import "@fontsource/source-code-pro/400-italic.css";
import "@fontsource/source-code-pro/700.css";
import "@fontsource/source-code-pro/700-italic.css";
import "@fontsource/ibm-plex-mono/300.css";
import "@fontsource/ibm-plex-mono/300-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/400-italic.css";
import "@fontsource/ibm-plex-mono/700.css";
import "@fontsource/ibm-plex-mono/700-italic.css";
import "@fontsource/roboto-mono/300.css";
import "@fontsource/roboto-mono/300-italic.css";
import "@fontsource/roboto-mono/400.css";
import "@fontsource/roboto-mono/400-italic.css";
import "@fontsource/roboto-mono/700.css";
import "@fontsource/roboto-mono/700-italic.css";
import "@fontsource/ubuntu-mono/400.css";
import "@fontsource/ubuntu-mono/400-italic.css";
import "@fontsource/ubuntu-mono/700.css";
import "@fontsource/ubuntu-mono/700-italic.css";
import "@fontsource/inconsolata/300.css";
import "@fontsource/inconsolata/400.css";
import "@fontsource/inconsolata/700.css";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/400-italic.css";
import "@fontsource/space-mono/700.css";
import "@fontsource/space-mono/700-italic.css";
import "@fontsource/victor-mono/300.css";
import "@fontsource/victor-mono/300-italic.css";
import "@fontsource/victor-mono/400.css";
import "@fontsource/victor-mono/400-italic.css";
import "@fontsource/victor-mono/700.css";
import "@fontsource/victor-mono/700-italic.css";
import "@fontsource/anonymous-pro/400.css";
import "@fontsource/anonymous-pro/400-italic.css";
import "@fontsource/anonymous-pro/700.css";
import "@fontsource/anonymous-pro/700-italic.css";
import "@fontsource/geist-mono/300.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/700.css";
import "@fontsource/martian-mono/300.css";
import "@fontsource/martian-mono/400.css";
import "@fontsource/martian-mono/700.css";

export interface BundledTermFont {
  /** Exact CSS family name registered by the css imports above. */
  family: string;
  /** Short hook shown in the picker. */
  note: string;
}

export const BUNDLED_TERM_FONTS: BundledTermFont[] = [
  { family: "Fira Code", note: "ligatures" },
  { family: "Hack", note: "classic terminal" },
  { family: "Source Code Pro", note: "Adobe" },
  { family: "IBM Plex Mono", note: "IBM" },
  { family: "Roboto Mono", note: "Google" },
  { family: "Ubuntu Mono", note: "Ubuntu" },
  { family: "Inconsolata", note: "compact" },
  { family: "Space Mono", note: "retro" },
  { family: "Victor Mono", note: "cursive italics" },
  { family: "Anonymous Pro", note: "coding classic" },
  { family: "Geist Mono", note: "Vercel" },
  { family: "Martian Mono", note: "wide & sturdy" },
];
