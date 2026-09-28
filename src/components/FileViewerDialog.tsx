import { useEffect, useRef, useState } from "react";
import { Check, Copy, FileText, FileWarning, WrapText } from "lucide-react";
import { toast } from "sonner";
import { useTheme } from "next-themes";

import type { TextFileContent } from "@/lib/types";
import { languageForFilename, monaco, monacoTheme } from "@/lib/monaco";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { cn, formatBytes, formatMtime } from "@/lib/utils";

interface Props {
  /** Bare file name — drives syntax highlighting. */
  fileName: string;
  /** Full path shown under the title (local absolute or remote path). */
  pathLabel: string;
  /**
   * Fetches the content. A closure so the dialog stays agnostic of
   * local vs remote — callers pass api.readLocalText / readRemoteText.
   */
  load: () => Promise<TextFileContent>;
  onClose: () => void;
}

/**
 * Read-only text preview backed by Monaco (lazy chunk — this component
 * must only be imported via React.lazy). Ctrl+F find, syntax highlight
 * by extension, wrap toggle, copy-all. Binary / oversized files get a
 * fallback message instead of an editor.
 *
 * Esc behavior: when Monaco's find widget is open the first Esc closes
 * it (Monaco swallows the key); the next Esc closes the dialog.
 */
export function FileViewerDialog({ fileName, pathLabel, load, onClose }: Props) {
  const { resolvedTheme } = useTheme();
  const [content, setContent] = useState<TextFileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  const language = languageForFilename(fileName) ?? "plaintext";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const c = await load();
        if (!cancelled) setContent(c);
      } catch (e) {
        toast.error(`Preview failed: ${e}`);
        if (!cancelled) onClose();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // The loader closure is stable for the dialog's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mount Monaco once the text is available.
  useEffect(() => {
    const el = containerRef.current;
    const text = content?.text;
    if (!el || text == null) return;

    const model = monaco.editor.createModel(text, language);
    const editor = monaco.editor.create(el, {
      model,
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      lineNumbers: "on",
      wordWrap: "off",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      fontSize: 12,
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
      theme: monacoTheme(resolvedTheme),
      // Read-only viewer: no need for the "cannot edit" tooltip chrome.
      contextmenu: true,
    });
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
      editor.dispose();
      model.dispose();
    };
    // Theme + wrap are applied via updateOptions below, not by re-creating.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  useEffect(() => {
    monaco.editor.setTheme(monacoTheme(resolvedTheme));
  }, [resolvedTheme]);

  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wrap ? "on" : "off" });
  }, [wrap]);

  async function copyAll() {
    if (content?.text == null) return;
    try {
      await navigator.clipboard.writeText(content.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      toast.error(`Copy failed: ${e}`);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="select-text flex h-[85vh] max-w-5xl flex-col gap-3 overflow-hidden p-4 sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            {fileName}
          </DialogTitle>
          <DialogDescription className="truncate font-mono text-[11px]">
            {pathLabel}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
            Reading file…
          </div>
        )}

        {!loading && content && (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b pb-2 text-xs text-muted-foreground">
              <span className="font-mono">{formatBytes(content.size)}</span>
              {content.mtime != null && (
                <span>{formatMtime(content.mtime)}</span>
              )}
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                {language}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  size="xs"
                  variant={wrap ? "secondary" : "ghost"}
                  className={cn(wrap && "ring-1 ring-primary/40")}
                  onClick={() => setWrap((w) => !w)}
                  disabled={content.text == null}
                  title="Toggle word wrap"
                >
                  <WrapText className="h-3.5 w-3.5" />
                  Wrap
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => void copyAll()}
                  disabled={content.text == null}
                  title="Copy file content"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  Copy
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
              {content.text != null ? (
                <div ref={containerRef} className="h-full w-full" />
              ) : (
                <div className="flex h-full items-center justify-center gap-2 bg-muted/30 p-4 text-sm text-muted-foreground">
                  <FileWarning className="h-4 w-4" />
                  {content.truncated
                    ? `File is larger than 1 MiB (${formatBytes(content.size)}) — download it to view.`
                    : "Binary content — preview not available."}
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
