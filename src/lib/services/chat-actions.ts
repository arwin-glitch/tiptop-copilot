import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { firstName, inviteEmail, voiceAction } from '@/lib/voice/actions';
import { composeHref, replyHref } from '@/lib/voice/handoff';
import { createTask } from './tasks';
import { whoIsMeant } from './who-is-meant';

/**
 * Ask Arwin doing things when asked in the chat, like Voice Arwin does:
 *
 *  - "remind me on Thursday to talk about Affinity" adds the task at once
 *    (asking for it in writing is the yes), with a button to it.
 *  - "reply to Patrick saying Wednesday works" and "book a coffee with
 *    Sarah" find the person and answer with a button that opens the email
 *    in the Inbox already written. Nothing is ever sent: the person reads it
 *    and clicks Send.
 *
 * Null for anything else, which goes on to the instant answers and then the
 * full Arwin as before.
 */

export interface ChatAction {
  kind: 'new_task' | 'reply' | 'invite';
  content: string;
  links: { label: string; href: string }[];
}

export async function actFromChat(
  store: DataStore,
  auth: AuthContext,
  question: string,
  options: { now?: Date } = {},
): Promise<ChatAction | null> {
  const zone = auth.profile.timezone || 'America/Chicago';
  // No page is open in the chat, so "snooze this" and "mark this done" stay voice-only.
  const action = voiceAction(question, { pathname: '', search: '' }, options.now, zone);
  if (!action) return null;

  if (action.kind === 'new_task') {
    const made = await createTask(auth, {
      title: action.title,
      detail: null,
      dueAt: action.dueAt ? action.dueAt.toISOString() : null,
    });
    if (!made.ok) return null;
    const due = action.dueLabel ? `, due ${action.dueLabel}` : '';
    return {
      kind: 'new_task',
      content: `Done - added to Tasks: ${action.title}${due}.`,
      links: [
        { label: 'Open the task', href: `/tasks/${made.value.id}` },
        { label: 'Open Tasks', href: '/tasks' },
      ],
    };
  }

  if (action.kind !== 'reply' && action.kind !== 'invite') return null;
  const who = await whoIsMeant(store, auth, action.who);
  if (!who.match) {
    return {
      kind: action.kind,
      content: who.candidates.length
        ? `I found a few people called ${action.who}: ${who.candidates
            .slice(0, 3)
            .map((c) => (c.name ? `${c.name} (${c.email})` : c.email))
            .join(', ')}. Which one? Say the full name and I'll open it.`
        : `I couldn't find ${action.who} in Nick's mail or calendar.`,
      links: [],
    };
  }
  const name = who.match.name ?? who.match.email;
  const first = firstName(who.match.name, who.match.email);

  if (action.kind === 'reply') {
    if (!who.match.thread) {
      return {
        kind: 'reply',
        content: `I found ${name}, but no email thread with them to reply to.`,
        links: [],
      };
    }
    return {
      kind: 'reply',
      content: action.text
        ? `Your reply to ${name} on "${who.match.thread.subject}" is written. Open it, check it and hit send - nothing goes until you do.`
        : `Here's ${name}'s last email, "${who.match.thread.subject}", with the reply box open.`,
      links: [
        { label: `Open the reply to ${first}`, href: replyHref(who.match.thread.id, action.text) },
      ],
    };
  }

  const mail = inviteEmail(
    { name: who.match.name, email: who.match.email },
    action.meeting,
    env().appUrl.replace(/\/+$/, ''),
  );
  const what = action.meeting === 'call' ? 'a call' : `a ${action.meeting}`;
  return {
    kind: 'invite',
    content: `An email to ${name} for ${what}, with Nick's booking link, is written. Open it, check it and hit send - nothing goes until you do.`,
    links: [{ label: `Open the email to ${first}`, href: composeHref(mail) }],
  };
}
