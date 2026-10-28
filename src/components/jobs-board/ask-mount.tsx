import { ASSISTANT_GREETING, ASSISTANT_SUGGESTIONS } from '@/lib/jobs-board/assistant';
import type { PublicBoard } from '@/lib/jobs-board/public';
import { readJobsAssistantCached } from '@/lib/services/jobs-chat';
import { AskArwin } from './ask-arwin';
import './ask.css';

/**
 * Puts "Ask Arwin" on a public board page: only while the board is on for
 * visitors (never on the signed-in preview or "coming soon") and the
 * assistant is switched on in Portfolio > Jobs.
 */
export async function AskArwinMount({
  board,
  preview,
}: {
  board: PublicBoard | null;
  preview: boolean;
}) {
  if (!board || preview) return null;
  const assistant = await readJobsAssistantCached();
  if (!assistant?.enabled) return null;
  return <AskArwin greeting={ASSISTANT_GREETING} chips={ASSISTANT_SUGGESTIONS} />;
}
