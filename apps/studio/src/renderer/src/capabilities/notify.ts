/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CapabilityHandler } from './registry';
import { notify, type NotifyInput } from '../notifications';
import { AGENTS, agentKindForClient } from '../../../shared/agentConsole';
import { ASSISTANT_NAME } from '../../../shared/assistant';

/** The longest title a caller may put in a toast: one line, as the spec says. */
export const NOTICE_TITLE_MAX = 120;
/** The longest detail kept. Enough for a summary, not for a page of instructions. */
export const NOTICE_DETAIL_MAX = 600;

// C0/C1 controls (a newline survives in a detail), bidirectional overrides and isolates, and
// zero-width characters: what would let text disguise what it says or where it points.
const UNSAFE_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text;
}

/** Who a notice is from, as the toast names it: the agent the client says it is when we know that
 *  agent, the app's own assistant when there is no client, and a plain "an agent" otherwise. A
 *  client names ITSELF, so an unknown name is never shown: it could be anything, "SnoutData" too. */
export function noticeSender(client: string | undefined): string {
	if (!client) {
		return ASSISTANT_NAME;
	}
	const kind = agentKindForClient(client);
	return kind ? AGENTS[kind].label : 'an agent';
}

/**
 * A notice a model asked for, made safe to show in the app's own style.
 *
 * A model (the assistant, or an agent that may have read a prompt-injected page) can write
 * anything here, and a toast in the app's own voice is a place a phishing line would be believed.
 * So the notice always says who it is from, its text is capped and stripped of characters that
 * disguise text, and it is shown as plain text: no link or command in it is ever made clickable.
 */
export function agentNotice(args: Record<string, unknown>, client: string | undefined): NotifyInput | null {
	const title = clip((typeof args.title === 'string' ? args.title : '').replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim(), NOTICE_TITLE_MAX);
	if (!title) {
		return null;
	}
	const rawDetail = typeof args.detail === 'string' ? args.detail.replace(/\r\n?/g, '\n').replace(UNSAFE_CHARS, ' ').trim() : '';
	return {
		severity: args.severity === 'warn' || args.severity === 'error' ? args.severity : 'info',
		title,
		detail: rawDetail ? clip(rawDetail, NOTICE_DETAIL_MAX) : undefined,
		source: client ? 'agent' : 'assistant',
		from: noticeSender(client),
	};
}

/**
 * Telling the user something, in the app.
 *
 * An agent working in the console produces things worth surfacing after the user has looked away:
 * a long job finished, a migration needs a decision, something looked wrong. Without this the only
 * place to say so is the terminal, which is exactly the surface the user is not watching.
 *
 * It lands in the app's own notifications center, which already persists across restarts and
 * already offers "Ask AI", rather than an OS balloon we would have to build a life for. Tagged
 * `source: 'agent'` (or `'assistant'`, the app's own) with a `from` the toast shows, so the user
 * can always tell a model's notice from the app's (see {@link agentNotice}).
 *
 * Counted as non-mutating: it writes no data, changes no setting, and touches nothing the user
 * would have to undo. Requiring consent for "may I tell you something" trains the reflex that
 * makes real consent prompts worthless.
 */
export const notifyCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'notify_user',
			description: 'Tell the user something in the app: it appears in the notifications bell and is kept in their notification history. Use it when work finishes, when you need a decision, or when you find something the user should know about while they are looking elsewhere. Do not use it for ordinary chat replies.',
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string', description: `One line, what happened. Shown in the toast, at most ${NOTICE_TITLE_MAX} characters.` },
					detail: { type: 'string', description: `Optional longer text, shown when the entry is expanded, at most ${NOTICE_DETAIL_MAX} characters. Plain text: links are not clickable.` },
					severity: { type: 'string', enum: ['info', 'warn', 'error'], description: 'How it should read. Defaults to info.' },
				},
				required: ['title'],
			},
			domain: 'notifications',
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: (args, ctx) => {
			const notice = agentNotice(args, ctx.client);
			if (!notice) {
				return { ok: false, summary: '', error: 'Provide a title: the one line the user will read.' };
			}
			const id = notify(notice);
			return { ok: true, summary: `Told the user: ${notice.title}`, data: { id } };
		},
	},
];
