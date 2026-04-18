import { createContext, useCallback, useContext, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";

/**
 * Options for a single confirm prompt.
 */
export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  /** Text on the primary (confirm) button. Default "Confirm". */
  confirmText?: string;
  /** Text on the cancel button. Default "Cancel". */
  cancelText?: string;
  /** Visually emphasize danger (red confirm button). */
  danger?: boolean;
}

type Resolver = (ok: boolean) => void;

interface ConfirmContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

/**
 * Provider — mount near the top of the tree (App.tsx wraps everything).
 * Renders a single shared Dialog that is reused for every prompt.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<Resolver | null>(null);

  const confirm = useCallback((o: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setOpts(o);
    });
  }, []);

  const finish = (ok: boolean) => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setOpts(null);
    r?.(ok);
  };

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <Dialog open={!!opts} onOpenChange={(v) => !v && finish(false)}>
        {opts && (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle
                  className={
                    opts.danger
                      ? "h-5 w-5 text-destructive"
                      : "h-5 w-5 text-yellow-500"
                  }
                />
                {opts.title}
              </DialogTitle>
              {opts.description && (
                <DialogDescription asChild>
                  <div className="pt-2 text-sm leading-relaxed">
                    {opts.description}
                  </div>
                </DialogDescription>
              )}
            </DialogHeader>
            <DialogFooter className="mt-2 gap-2">
              <Button variant="outline" onClick={() => finish(false)} autoFocus>
                {opts.cancelText ?? "Cancel"}
              </Button>
              <Button
                variant={opts.danger ? "destructive" : "default"}
                onClick={() => finish(true)}
              >
                {opts.confirmText ?? "Confirm"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/**
 * Hook — call from any component:
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: "Delete?", danger: true })) { ... }
 */
export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx.confirm;
}
