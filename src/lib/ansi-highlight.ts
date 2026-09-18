/**
 * Client-side output colorizer, MobaXterm-style.
 *
 * xterm already renders any color the *server* sends (ls --color, colored
 * prompts, git, vim, htop, …) — that is untouched here. This transform only
 * adds color to *plain* text the server did NOT color: IPv4 addresses and a
 * configurable set of log keywords (error / warn / …).
 *
 * It is deliberately a heuristic, not a full VT parser, but it is written to
 * be SAFE against the ways naive SGR injection breaks a real PTY:
 *
 *   1. Streaming UTF-8 decode      → multibyte chars split across chunks are
 *                                     reassembled by the TextDecoder.
 *   2. Escape-sequence awareness   → bytes inside an ESC/CSI/OSC sequence are
 *                                     passed through verbatim, never wrapped.
 *   3. Split-escape carry-over     → a sequence cut off at a chunk boundary is
 *                                     buffered and finished on the next chunk.
 *   4. Alternate-screen guard      → while a full-screen app (vim/htop/less)
 *                                     owns the screen, NOTHING is wrapped.
 *   5. Already-colored guard       → text inside a server SGR span is left
 *                                     alone, so we never double-color.
 *
 * One instance per terminal (it carries cross-chunk state).
 */

const ESC = "\x1b";
const RESET = `${ESC}[0m`;

const SGR = {
  ipv4: `${ESC}[36m`, // cyan
  keywordError: `${ESC}[31m`, // red
  keywordWarn: `${ESC}[33m`, // yellow
} as const;

// Strict IPv4 (each octet 0-255) so we don't paint version strings like
// "1.2.3.4" that happen to look like an address... actually those DO look
// like addresses; the octet clamp only rejects >255, which is the useful bit.
const IPV4_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Match {
  start: number;
  end: number;
  sgr: string;
}

export interface HighlightOpts {
  ipv4: boolean;
  keywords: string[];
  /** Whether colorization is active. State (escape/alt-screen tracking) is
   *  maintained regardless, so toggling mid-stream stays correct. */
  enabled?: boolean;
}

export class AnsiHighlighter {
  private decoder = new TextDecoder("utf-8", { fatal: false });
  /** Raw text of an escape sequence cut off at the end of a chunk. */
  private carry = "";
  /** Inside a vim/htop/less alternate screen buffer? */
  private altScreen = false;
  /** Inside a non-reset server SGR span? */
  private inSgr = false;
  private keywordRe: RegExp | null = null;
  private enabled: boolean;

  constructor(private opts: HighlightOpts) {
    this.enabled = opts.enabled ?? true;
    this.setKeywords(opts.keywords);
  }

  /** Turn colorization on/off. Cheap — the scan (which tracks escape /
   *  alt-screen state) always runs so state stays accurate across toggles. */
  setEnabled(v: boolean) {
    this.enabled = v;
  }

  setKeywords(list: string[]) {
    const cleaned = list.map((s) => s.trim()).filter(Boolean);
    this.keywordRe =
      cleaned.length === 0
        ? null
        : new RegExp(`\\b(?:${cleaned.map(escapeRegex).join("|")})\\b`, "gi");
  }

  reset() {
    this.carry = "";
    this.altScreen = false;
    this.inSgr = false;
    this.decoder = new TextDecoder("utf-8", { fatal: false });
  }

  transform(bytes: Uint8Array): string {
    const text = this.carry + this.decoder.decode(bytes, { stream: true });
    this.carry = "";

    let out = "";
    let plain = ""; // accumulated plain-text run (state === text)
    let i = 0;
    const n = text.length;

    const flushPlain = () => {
      if (!plain) return;
      // Only colorize genuinely plain text: feature on, not while a
      // full-screen app is up, and not inside a server-colored span.
      out +=
        this.enabled && !this.altScreen && !this.inSgr
          ? this.colorize(plain)
          : plain;
      plain = "";
    };

    while (i < n) {
      const ch = text[i];
      if (ch !== ESC) {
        plain += ch;
        i++;
        continue;
      }

      // --- start of an escape sequence: flush the plain run first ---
      flushPlain();
      const seqStart = i;
      const parsed = this.parseEscape(text, i);
      if (parsed === null) {
        // Incomplete sequence at end of chunk → carry it to next time.
        this.carry = text.slice(seqStart);
        // Defensive: if a malformed stream never terminates the sequence,
        // don't let the carry grow without bound — flush it as literal.
        if (this.carry.length > 256) {
          out += this.carry;
          this.carry = "";
        }
        return out;
      }
      // Emit the escape sequence verbatim and apply its side effects.
      out += text.slice(seqStart, parsed.end);
      this.applyEffect(text.slice(seqStart, parsed.end));
      i = parsed.end;
    }

    flushPlain();
    return out;
  }

  /**
   * Given `text[start] === ESC`, return the end index (exclusive) of the
   * escape sequence, or null if the sequence runs past the end of `text`
   * (incomplete — should be carried over).
   */
  private parseEscape(text: string, start: number): { end: number } | null {
    const n = text.length;
    if (start + 1 >= n) return null;
    const b = text[start + 1];

    // CSI: ESC [ ... final(0x40-0x7E)
    if (b === "[") {
      let j = start + 2;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) return { end: j + 1 };
        j++;
      }
      return null;
    }
    // OSC: ESC ] ... terminated by BEL (0x07) or ST (ESC \)
    if (b === "]") {
      let j = start + 2;
      while (j < n) {
        if (text.charCodeAt(j) === 0x07) return { end: j + 1 };
        if (text[j] === ESC && j + 1 < n && text[j + 1] === "\\")
          return { end: j + 2 };
        // ST split across the boundary — incomplete.
        if (text[j] === ESC && j + 1 >= n) return null;
        j++;
      }
      return null;
    }
    // SS3 / other 2-byte escapes: ESC O x, ESC ( x, ESC ) x, etc. — the
    // final byte is the next char.
    if (b === "O" || b === "(" || b === ")" || b === "#") {
      return start + 2 < n ? { end: start + 3 } : null;
    }
    // Any other short escape (ESC 7, ESC =, ESC >, …): 2 bytes.
    return { end: start + 2 };
  }

  /** Update altScreen / inSgr flags from a complete escape sequence. */
  private applyEffect(seq: string) {
    // Only CSI sequences carry the modes we care about.
    if (seq.length < 3 || seq[1] !== "[") return;
    const final = seq[seq.length - 1];
    const params = seq.slice(2, seq.length - 1); // between "[" and final

    // Alternate-screen enable/disable: ESC [ ? {47,1047,1049} h|l
    if (params[0] === "?" && (final === "h" || final === "l")) {
      const nums = params.slice(1).split(";");
      if (nums.some((p) => p === "47" || p === "1047" || p === "1049")) {
        this.altScreen = final === "h";
      }
      return;
    }

    // SGR: ESC [ params m — track whether a non-reset color is active.
    if (final === "m") {
      if (params === "" || params === "0") this.inSgr = false;
      else this.inSgr = true;
    }
  }

  /** Wrap IPv4 + keyword matches in SGR codes. Called only on plain text. */
  private colorize(run: string): string {
    const matches: Match[] = [];

    if (this.opts.ipv4) {
      IPV4_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = IPV4_RE.exec(run)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length, sgr: SGR.ipv4 });
      }
    }

    if (this.keywordRe) {
      this.keywordRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = this.keywordRe.exec(run)) !== null) {
        const sgr = /warn/i.test(m[0]) ? SGR.keywordWarn : SGR.keywordError;
        matches.push({ start: m.index, end: m.index + m[0].length, sgr });
      }
    }

    if (matches.length === 0) return run;

    // Sort left→right, drop overlaps (keep the earlier match).
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    let out = "";
    let cursor = 0;
    for (const mt of matches) {
      if (mt.start < cursor) continue; // overlaps a match we already emitted
      out += run.slice(cursor, mt.start);
      out += mt.sgr + run.slice(mt.start, mt.end) + RESET;
      cursor = mt.end;
    }
    out += run.slice(cursor);
    return out;
  }
}
