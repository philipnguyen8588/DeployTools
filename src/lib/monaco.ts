// Monaco, assembled lean for read-only viewing + diffing.
//
// We deliberately do NOT import the full `monaco-editor` entry: it wires
// up the css/html/json/typescript language SERVICES, each wanting its own
// web worker and producing validation squiggles — noise for a read-only
// preview, and megabytes of extra chunks. Instead this module pulls the
// editor core, the find widget, the diff editor, and every Monarch
// tokenizer (`basic-languages` — pure syntax highlight, worker-free).
// Only the generic editor worker is needed.
//
// Deep-import paths are technically private API (README: "everything else
// is considered private") — monaco-editor is pinned in package.json;
// revisit these imports on upgrade.
//
// Import this ONLY from React.lazy'd components — the chunk is ~2 MB and
// must not weigh down app start.
import * as monaco from "monaco-editor/editor/editor.api.js";

import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js";
import "monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js";
// Find widget (Ctrl+F) — the register + the controller are separate.
import "monaco-editor/features/find/register.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/editor/contrib/tokenization/browser/tokenization.js";
// Codicon font — find-widget arrows, folding chevrons, close buttons.
// (via the `monaco-esm` vite alias: the package exports map only allows
// *.js subpaths, so CSS can't be imported through `monaco-editor/…`.)
import "monaco-esm/base/browser/ui/codicons/codicon/codicon.css";
import "monaco-esm/base/browser/ui/codicons/codicon/codicon-modifiers.css";
// Every Monarch tokenizer (~80 languages) — syntax colors only.
import "monaco-editor/basic-languages/monaco.contribution.js";

import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

// One worker type serves everything we load (no language services).
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export { monaco };

/** Map the app theme (next-themes resolvedTheme) to a Monaco theme. */
export function monacoTheme(resolved: string | undefined): string {
  return resolved === "dark" ? "vs-dark" : "vs";
}

/**
 * Best-effort language id from a file name, via the registered languages'
 * extension/filename lists. Returns undefined → plaintext.
 */
export function languageForFilename(name: string): string | undefined {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : "";
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === base.toLowerCase())) {
      return lang.id;
    }
    if (ext && lang.extensions?.some((e) => e.toLowerCase() === ext)) {
      return lang.id;
    }
  }
  return undefined;
}
