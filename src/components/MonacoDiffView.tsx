import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useTheme } from "next-themes";

import { languageForFilename, monaco, monacoTheme } from "@/lib/monaco";

export interface DiffViewHandle {
  next: () => void;
  prev: () => void;
}

interface Props {
  /** Left side (local). */
  original: string;
  /** Right side (remote). */
  modified: string;
  /** Drives syntax highlighting for both panes. */
  fileName: string;
  /** true → side-by-side, false → inline. Applied live, no re-create. */
  renderSideBySide: boolean;
  /** Reports the number of changed line-ranges after each diff compute. */
  onStats?: (changes: number) => void;
}

/**
 * Monaco diff editor wrapper (read-only). Word-level intra-line
 * highlighting and collapse-unchanged-regions (click to expand) are
 * built in. Only import via React.lazy — pulls the Monaco chunk.
 */
export const MonacoDiffView = forwardRef<DiffViewHandle, Props>(
  function MonacoDiffView(
    { original, modified, fileName, renderSideBySide, onStats },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
    const { resolvedTheme } = useTheme();

    // (Re)create when the compared content changes. Options that can be
    // switched live (view mode, theme) are applied in separate effects so
    // toggling them doesn't lose scroll/expand state.
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const lang = languageForFilename(fileName);
      const originalModel = monaco.editor.createModel(original, lang);
      const modifiedModel = monaco.editor.createModel(modified, lang);
      const editor = monaco.editor.createDiffEditor(el, {
        readOnly: true,
        automaticLayout: true,
        renderSideBySide,
        // Collapse unchanged regions — the headline feature. Click the
        // separator (or the arrows) to expand.
        hideUnchangedRegions: { enabled: true },
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderOverviewRuler: true,
        fontSize: 12,
        fontFamily:
          '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
        theme: monacoTheme(resolvedTheme),
      });
      editor.setModel({ original: originalModel, modified: modifiedModel });
      const sub = editor.onDidUpdateDiff(() => {
        onStats?.(editor.getLineChanges()?.length ?? 0);
      });
      editorRef.current = editor;
      return () => {
        sub.dispose();
        editorRef.current = null;
        editor.dispose();
        originalModel.dispose();
        modifiedModel.dispose();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [original, modified, fileName]);

    useEffect(() => {
      editorRef.current?.updateOptions({ renderSideBySide });
    }, [renderSideBySide]);

    useEffect(() => {
      monaco.editor.setTheme(monacoTheme(resolvedTheme));
    }, [resolvedTheme]);

    useImperativeHandle(
      ref,
      () => ({
        next: () => editorRef.current?.goToDiff("next"),
        prev: () => editorRef.current?.goToDiff("previous"),
      }),
      [],
    );

    return <div ref={containerRef} className="h-full w-full" />;
  },
);
