import 'server-only';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import type { RoutineBriefing } from '@/lib/types/domain';

/**
 * The Today card's "Open full briefing / dossier" as a PDF.
 *
 * The routines publish the full visual version as a claude.ai artifact, which
 * is created private and cannot be shared from inside the routine, so Nick
 * could not open it from the app. The app cannot fetch that page either. What
 * it does have is the routine's full text (`summary` carries every section,
 * not a teaser), so the PDF is built from that, served behind the app's own
 * sign-in. The Slack message keeps linking the artifact for Arwin.
 *
 * Only the 14 standard PDF fonts are used, so nothing is embedded or fetched;
 * their WinAnsi encoding cannot carry arrows or emoji, so those are mapped to
 * plain equivalents and anything else unencodable is dropped rather than
 * failing the whole document.
 */

const KIND_LABEL: Record<RoutineBriefing['kind'], string> = {
  morning: 'Morning Brief',
  afternoon: 'Afternoon Checkpoint',
  dossier: 'Meeting Dossier',
};

const PAGE = { width: 612, height: 792 }; // US Letter, in points
const MARGIN = { x: 56, top: 64, bottom: 60 };
const CONTENT_WIDTH = PAGE.width - MARGIN.x * 2;

const INK = rgb(0.11, 0.1, 0.09);
const MUTED = rgb(0.42, 0.4, 0.38);
const ACCENT = rgb(0.05, 0.55, 0.36);
const DANGER = rgb(0.72, 0.16, 0.12);
const RULE = rgb(0.86, 0.84, 0.82);

const REPLACEMENTS: Record<string, string> = {
  '→': '->',
  '←': '<-',
  '⇒': '=>',
  '↗': '',
  '✓': '',
  '✔': '',
  '✗': 'x',
  '✘': 'x',
  '≈': '~',
  '≥': '>=',
  '≤': '<=',
  ' ': ' ',
  '\t': '    ',
  '🔴': '(!)',
  '🟠': '(!)',
  '🟡': '',
  '🟢': '',
};

type Block =
  | { type: 'gap' }
  | { type: 'heading'; text: string; danger: boolean }
  | { type: 'bullet'; text: string; marker: string }
  | { type: 'para'; text: string };

const BULLET_RE = /^\s*([-*•·▪◦]|\d{1,2}[.)])\s+(.*)$/;

/** Plain-text summary -> blocks. Headings are short lines in capitals or ending in a colon. */
export function parseBriefingText(summary: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of summary.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      if (blocks.length && blocks[blocks.length - 1]!.type !== 'gap') blocks.push({ type: 'gap' });
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      const marker = /\d/.test(bullet[1]!) ? bullet[1]! : '•';
      blocks.push({ type: 'bullet', text: bullet[2]!.trim(), marker });
      continue;
    }
    const text = line.trim();
    const letters = text.replace(/[^A-Za-z]/g, '');
    const shouting = letters.length >= 3 && letters === letters.toUpperCase();
    const labelled = /:$/.test(text) && text.length <= 70;
    if (text.length <= 80 && (shouting || labelled)) {
      blocks.push({
        type: 'heading',
        text: text.replace(/:$/, ''),
        danger: /going stale|overdue|past due|urgent/i.test(text),
      });
      continue;
    }
    blocks.push({ type: 'para', text });
  }
  while (blocks.length && blocks[blocks.length - 1]!.type === 'gap') blocks.pop();
  return blocks;
}

function sanitizer(font: PDFFont): (text: string) => string {
  const supported = new Set(font.getCharacterSet());
  return (text) => {
    let out = '';
    for (const ch of text) {
      const mapped = REPLACEMENTS[ch] ?? ch;
      for (const c of mapped) if (supported.has(c.codePointAt(0)!)) out += c;
    }
    return out;
  };
}

/** Greedy word wrap; a single word wider than the line is broken by characters. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= width;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (fits(word)) {
      current = word;
      continue;
    }
    let piece = '';
    for (const ch of word) {
      if (!fits(piece + ch)) {
        lines.push(piece);
        piece = '';
      }
      piece += ch;
    }
    current = piece;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

export async function renderBriefingPdf(
  briefing: Pick<RoutineBriefing, 'kind' | 'title' | 'summary' | 'date_key' | 'posted_at'>,
  opts: { timeZone: string },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const label = KIND_LABEL[briefing.kind];
  doc.setTitle(briefing.title);
  doc.setSubject(label);
  doc.setProducer('TipTop Copilot');
  doc.setCreator('TipTop Copilot');

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const clean = sanitizer(regular);

  let page: PDFPage = doc.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN.top;

  const ensure = (height: number) => {
    if (y - height >= MARGIN.bottom) return;
    page = doc.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - MARGIN.top;
  };
  const text = (s: string, x: number, size: number, font: PDFFont, color: RGB) =>
    page.drawText(s, { x, y, size, font, color });

  // Masthead.
  page.drawRectangle({ x: 0, y: PAGE.height - 6, width: PAGE.width, height: 6, color: ACCENT });
  text(clean(`TIPTOP COPILOT  ·  ${label.toUpperCase()}`), MARGIN.x, 8.5, bold, ACCENT);
  y -= 26;
  for (const line of wrap(clean(briefing.title), bold, 20, CONTENT_WIDTH)) {
    ensure(24);
    text(line, MARGIN.x, 20, bold, INK);
    y -= 24;
  }
  const posted = new Date(briefing.posted_at);
  const postedLabel = Number.isNaN(posted.getTime())
    ? ''
    : ` · posted ${posted.toLocaleString('en-US', {
        timeZone: opts.timeZone,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      })}`;
  y -= 2;
  text(clean(`For ${briefing.date_key}${postedLabel}`), MARGIN.x, 9.5, regular, MUTED);
  y -= 16;
  page.drawLine({
    start: { x: MARGIN.x, y },
    end: { x: PAGE.width - MARGIN.x, y },
    thickness: 0.75,
    color: RULE,
  });
  y -= 22;

  // Body.
  const BODY = 10.5;
  const LEAD = 15;
  for (const block of parseBriefingText(briefing.summary)) {
    if (block.type === 'gap') {
      y -= 7;
      continue;
    }
    if (block.type === 'heading') {
      const color = block.danger ? DANGER : ACCENT;
      const lines = wrap(clean(block.text.toUpperCase()), bold, 10, CONTENT_WIDTH - 10);
      ensure(10 + lines.length * 14 + LEAD);
      y -= 8;
      page.drawRectangle({
        x: MARGIN.x,
        y: y - (lines.length - 1) * 14 - 3,
        width: 3,
        height: lines.length * 14,
        color,
      });
      for (const line of lines) {
        text(line, MARGIN.x + 10, 10, bold, color);
        y -= 14;
      }
      y -= 4;
      continue;
    }
    const indent = block.type === 'bullet' ? 16 : 0;
    const lines = wrap(clean(block.text), regular, BODY, CONTENT_WIDTH - indent);
    lines.forEach((line, i) => {
      ensure(LEAD);
      if (block.type === 'bullet' && i === 0) {
        text(clean(block.marker), MARGIN.x + 2, BODY, bold, MUTED);
      }
      text(line, MARGIN.x + indent, BODY, regular, INK);
      y -= LEAD;
    });
    y -= 3;
  }

  // Footers, once the page count is known.
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(
      clean(
        `TipTop Copilot · ${label} · page ${i + 1} of ${pages.length} · confidential, for Nick and Arwin`,
      ),
      { x: MARGIN.x, y: 32, size: 7.5, font: regular, color: MUTED },
    );
  });

  return doc.save();
}
