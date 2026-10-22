import type { TranscriptTrack } from '@/lib/types/notes';

/**
 * Turning the speech engine's finished pieces into transcript lines (D-076).
 *
 * Whisper finishes a stretch of speech at a time, and a stretch can end
 * mid-sentence (the chunker cuts at the longest pause it can find); a line
 * per piece would make a transcript of fragments. The assembler joins one
 * voice's finished pieces into a line and closes it at the end of a
 * sentence, when the voice changes, after a pause, or when it grows long.
 * The demo engine already finishes whole turns, which pass through as they
 * are (each ends a sentence).
 */

export interface FinishedPiece {
  track: TranscriptTrack;
  speakerLabel: string | null;
  /** Recording-clock milliseconds. */
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
}

export interface AssembledLine extends FinishedPiece {
  /** How many engine pieces went into the line. */
  pieces: number;
}

export interface LineAssemblerOptions {
  /** A pause longer than this between pieces starts a new line. */
  gapMs: number;
  /** A line that has heard nothing new for this long closes. */
  idleMs: number;
  /** A line longer than this closes at the next piece. */
  maxChars: number;
}

export const DEFAULT_LINE_OPTIONS: LineAssemblerOptions = {
  gapMs: 1500,
  idleMs: 2500,
  maxChars: 400,
};

const SENTENCE_END = /[.?!…]["')\]]?$/;

/** Join two pieces of text the way the words were said. */
export function joinText(a: string, b: string): string {
  const left = a.trimEnd();
  const right = b.trimStart();
  if (!left) return right;
  if (!right) return left;
  // Punctuation that belongs to the previous word.
  if (/^[,.;:?!…%)\]'"]/.test(right)) return left + right;
  return `${left} ${right}`;
}

export class LineAssembler {
  private pending: { line: AssembledLine; confidenceSum: number; confidenceN: number } | null =
    null;
  private readonly options: LineAssemblerOptions;

  constructor(
    private readonly emit: (line: AssembledLine) => void,
    options: Partial<LineAssemblerOptions> = {},
  ) {
    this.options = { ...DEFAULT_LINE_OPTIONS, ...options };
  }

  /** The line being built, for the live view. */
  current(): AssembledLine | null {
    return this.pending?.line ?? null;
  }

  add(piece: FinishedPiece): void {
    const text = piece.text.trim();
    if (!text) return;
    const p = this.pending;
    if (
      p &&
      (p.line.speakerLabel !== piece.speakerLabel ||
        piece.startMs - p.line.endMs > this.options.gapMs ||
        p.line.text.length >= this.options.maxChars)
    ) {
      this.flush();
    }
    if (!this.pending) {
      this.pending = {
        line: { ...piece, text, pieces: 1 },
        confidenceSum: piece.confidence ?? 0,
        confidenceN: piece.confidence == null ? 0 : 1,
      };
    } else {
      const line = this.pending.line;
      line.text = joinText(line.text, text);
      line.endMs = Math.max(line.endMs, piece.endMs);
      line.pieces += 1;
      if (piece.confidence != null) {
        this.pending.confidenceSum += piece.confidence;
        this.pending.confidenceN += 1;
      }
    }
    if (SENTENCE_END.test(this.pending.line.text)) this.flush();
  }

  /** Close the line if nothing new has arrived for a while (`nowMs` on the recording clock). */
  tick(nowMs: number): void {
    if (this.pending && nowMs - this.pending.line.endMs >= this.options.idleMs) this.flush();
  }

  flush(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const confidence = p.confidenceN > 0 ? p.confidenceSum / p.confidenceN : null;
    this.emit({ ...p.line, confidence });
  }
}
