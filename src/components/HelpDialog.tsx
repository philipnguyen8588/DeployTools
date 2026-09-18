import {
  HelpCircle,
  Rocket,
  Keyboard,
  ShieldCheck,
  TerminalSquare,
  Braces,
  History as HistoryIcon,
  Container,
  FolderTree,
  PlugZap,
  Coffee,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";

interface Props {
  onClose: () => void;
}

/**
 * One-screen reference for the app: what it does, the main workflows,
 * and every keyboard shortcut. Kept purely static (no stateful input)
 * so it's cheap to open + read repeatedly.
 */
export function HelpDialog({ onClose }: Props) {
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HelpCircle className="h-5 w-5 text-primary" />
            About DeployTools
          </DialogTitle>
          <DialogDescription>
            A desktop tool to deploy web projects from local to remote
            servers over SSH / SFTP / FTP. Everything sensitive is
            encrypted at rest in a portable vault.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1 text-sm">
          {/* ---- Overview ---- */}
          <Section icon={<Rocket className="h-4 w-4 text-primary" />} title="What it does">
            <ul className="ml-5 list-disc space-y-1 text-muted-foreground">
              <li>Manage multiple SSH / FTP servers with per-project configs.</li>
              <li>
                Browse local ↔ remote files side by side, drag-drop upload,
                compare diffs.
              </li>
              <li>
                Native SFTP <strong>Sync</strong> (no rsync needed) —
                incremental upload, optional delete-remote-extras.
              </li>
              <li>
                Integrated xterm terminal, one-click Docker Compose / systemd
                actions that all spawn a new terminal tab.
              </li>
              <li>
                Per-server command <strong>History</strong> + reusable
                <strong> Snippets</strong> library (vault-encrypted).
              </li>
              <li>Cloudflare DNS manager for quick record edits.</li>
            </ul>
          </Section>

          {/* ---- Vault ---- */}
          <Section
            icon={<ShieldCheck className="h-4 w-4 text-green-500" />}
            title="Vault"
          >
            <p className="text-muted-foreground">
              Servers, keys, tokens, snippets and terminal history live
              inside <code className="font-mono">vault.enc</code> — AES-256-GCM,
              Argon2id key derivation. The vault file sits next to the
              running exe by default (portable) and can be relocated via
              <strong> Settings → Change location</strong>. Lock with the
              🔒 button or <Shortcut>Ctrl+L</Shortcut> (if you're on the
              unlocked screen).
            </p>
          </Section>

          {/* ---- Typical workflow ---- */}
          <Section
            icon={<FolderTree className="h-4 w-4 text-primary" />}
            title="Typical workflow"
          >
            <ol className="ml-5 list-decimal space-y-1 text-muted-foreground">
              <li>
                Sidebar → click <strong>＋</strong> to add a server, choose
                protocol (SSH / FTP / FTPS). Paste a private key or point
                at a key file; passphrase is optional.
              </li>
              <li>
                On the server row, the ⋮ menu → <strong>Add project</strong>.
                Pick the local folder + remote path + excludes.
              </li>
              <li>
                Hover the project → ▶ to open a session tab. File browsers
                + terminal load inside.
              </li>
              <li>
                Top bar → <strong>Sync</strong> uploads every new/changed
                file via SFTP. <strong>Sync + delete</strong> also removes
                remote files the local no longer has.
              </li>
              <li>
                Bottom panel → <strong>Terminal</strong> to run commands.
                Docker / Services tabs give button-click actions that open
                a fresh terminal running the command.
              </li>
            </ol>
          </Section>

          {/* ---- Terminal power-ups ---- */}
          <Section
            icon={<TerminalSquare className="h-4 w-4 text-primary" />}
            title="Terminal power-ups"
          >
            <ul className="ml-5 list-disc space-y-1 text-muted-foreground">
              <li>
                <Braces className="mr-0.5 inline h-3 w-3" /> <strong>Snippets</strong>
                — reusable `sh -c` commands with <code className="font-mono">{`{{VAR}}`}</code>
                placeholders. Built-ins auto-fill: <code className="font-mono">HOST</code>,
                <code className="font-mono"> USER</code>,
                <code className="font-mono"> PORT</code>,
                <code className="font-mono"> REMOTE_PATH</code>,
                <code className="font-mono"> LOCAL_PATH</code>,
                <code className="font-mono"> PROJECT_NAME</code>.
                Picking a snippet pastes the resolved command at the
                prompt — you review then hit Enter.
              </li>
              <li>
                <HistoryIcon className="mr-0.5 inline h-3 w-3" /> <strong>History</strong>
                — every line you press Enter on is appended to a
                per-server log (capped at 500 entries, duplicates
                collapse). Search + pick to replay.
              </li>
              <li>
                Idle auto-disconnect keeps long-running SSH sessions from
                squatting on the server — threshold in
                <strong> Settings</strong>. A disconnected tab shows a
                Reconnect overlay.
              </li>
            </ul>
          </Section>

          {/* ---- Docker / services ---- */}
          <Section
            icon={<Container className="h-4 w-4 text-primary" />}
            title="Docker / Services"
          >
            <p className="text-muted-foreground">
              Every button (<strong>Up</strong> · <strong>Restart</strong> ·
              <strong> Stop</strong> · <strong>Build</strong> ·
              <strong> Logs</strong> · <strong>Shell</strong>) opens a new
              terminal tab seeded with the corresponding
              <code className="font-mono"> docker compose …</code> command.
              This gives you full live output, Ctrl+C to abort, and a
              chance to edit the command before Enter.
            </p>
          </Section>

          {/* ---- Keyboard shortcuts ---- */}
          <Section
            icon={<Keyboard className="h-4 w-4 text-primary" />}
            title="Keyboard shortcuts"
          >
            <div className="rounded-md border">
              <ShortcutRow keys={["Ctrl", "Shift", "S"]}>
                Open Snippets picker (while on a Terminal tab)
              </ShortcutRow>
              <ShortcutRow keys={["Ctrl", "Shift", "H"]}>
                Open Terminal History picker
              </ShortcutRow>
              <ShortcutRow keys={["↑", "↓"]}>
                Navigate items inside any picker dialog
              </ShortcutRow>
              <ShortcutRow keys={["Enter"]}>
                Pick the selected snippet / history entry
              </ShortcutRow>
              <ShortcutRow keys={["Esc"]}>
                Close the currently open dialog
              </ShortcutRow>
              <ShortcutRow keys={["Ctrl", "Shift", "V"]}>
                Paste clipboard into the terminal
              </ShortcutRow>
              <ShortcutRow keys={["Ctrl", "Shift", "C"]}>
                Copy terminal selection (if any)
              </ShortcutRow>
              <ShortcutRow keys={["Right-click"]}>
                Also pastes clipboard (Windows convention)
              </ShortcutRow>
              <ShortcutRow keys={["Select text"]}>
                Auto-copies selection to clipboard (xterm convention)
              </ShortcutRow>
              <ShortcutRow keys={["Ctrl", "C"]} last>
                Inside the terminal: interrupt the running command
              </ShortcutRow>
            </div>
          </Section>

          {/* ---- Status bar ---- */}
          <Section
            icon={<PlugZap className="h-4 w-4 text-primary" />}
            title="Status bar legend"
          >
            <ul className="ml-5 list-disc space-y-1 text-muted-foreground">
              <li>
                <span className="inline-block h-2 w-2 rounded-full bg-green-500 align-middle"></span>
                {"  "}green dot — live connection
              </li>
              <li>
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-yellow-500 align-middle"></span>
                {"  "}amber — reconnecting
              </li>
              <li>
                <span className="inline-block h-2 w-2 rounded-full bg-red-500 align-middle"></span>
                {"  "}red — disconnected (click Reconnect on the overlay)
              </li>
              <li>Git branch + HEAD are shown when the project is a repo.</li>
            </ul>
          </Section>

          {/* ---- Credits ---- */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <div className="text-xs text-muted-foreground">
              Made by{" "}
              <span className="font-medium text-foreground">LipNguyen</span>
              {" · "}
              <a
                href="mailto:philip.nguyen8588@gmail.com"
                className="text-primary hover:underline"
              >
                philip.nguyen8588@gmail.com
              </a>
            </div>
            <a
              href="https://buymeacoffee.com/lipnguyen"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md bg-[#FFDD00] px-3 py-1.5 text-xs font-semibold text-black transition hover:brightness-95"
            >
              <Coffee className="h-3.5 w-3.5" />
              Buy me a coffee
            </a>
          </div>
        </div>

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h3>
      <div className="text-xs leading-relaxed">{children}</div>
    </section>
  );
}

function ShortcutRow({
  keys,
  children,
  last,
}: {
  keys: string[];
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={
        "flex items-center gap-3 px-3 py-1.5 text-xs" +
        (last ? "" : " border-b")
      }
    >
      <div className="flex shrink-0 items-center gap-1">
        {keys.map((k, i) => (
          <span key={i}>
            <Kbd>{k}</Kbd>
            {i < keys.length - 1 && (
              <span className="mx-0.5 text-muted-foreground">+</span>
            )}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1 text-muted-foreground">{children}</div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-block min-w-[1.5rem] rounded border bg-muted px-1.5 py-0.5 text-center font-mono text-[10px] shadow-sm">
      {children}
    </kbd>
  );
}

function Shortcut({ children }: { children: React.ReactNode }) {
  return <Kbd>{children}</Kbd>;
}
