/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What SnoutData AI's gateway (Psyche) means when it refuses a call for a budget or a rate limit,
 * and the sentence a person is shown for it.
 *
 * Psyche answers 429 with `code` (`budget_exceeded` or `rate_limit_exceeded`) and `scope`: whose
 * budget or limit it was (`user`: the person's own wallet, `group`: their team's pool, `project`:
 * the ceiling on all of SnoutData AI, `key`). Its own message names budgets by their internal
 * names, which is right for an API and wrong for a chat, so the scope picks the sentence instead.
 *
 * Import-free on purpose: the build copies this file into the Snout Functions
 * (`_shared/gatewayRefusal.ts`) so the dashboard's assistant says exactly what Studio says.
 */

export type RefusalScope = 'user' | 'group' | 'project' | 'key';

export interface GatewayRefusal {
	code: 'budget_exceeded' | 'rate_limit_exceeded';
	/** Whose budget or limit; null from a gateway too old to say. */
	scope: RefusalScope | null;
	/** "30s", "2m", from the limit's own sentence; null when it gave none. */
	retryIn: string | null;
}

const SCOPES: readonly string[] = ['user', 'group', 'project', 'key'];

/** The refusal in an error's text: the gateway's JSON body, alone or after a prefix such as
 *  "OpenAI 429: ". Null for anything that is not a budget or rate-limit refusal. */
export function gatewayRefusal(text: string): GatewayRefusal | null {
	const start = text.indexOf('{');
	let code: unknown;
	let scope: unknown;
	let message = text;
	if (start >= 0) {
		try {
			const error = (JSON.parse(text.slice(start)) as { error?: { code?: unknown; scope?: unknown; message?: unknown } }).error;
			code = error?.code;
			scope = error?.scope;
			if (typeof error?.message === 'string') {
				message = error.message;
			}
		} catch {
			// not JSON after all: the codes are still looked for in the text
		}
	}
	if (code !== 'budget_exceeded' && code !== 'rate_limit_exceeded') {
		code = /\bbudget_exceeded\b/.test(text) ? 'budget_exceeded' : /\brate_limit_exceeded\b/.test(text) ? 'rate_limit_exceeded' : null;
	}
	if (code !== 'budget_exceeded' && code !== 'rate_limit_exceeded') {
		return null;
	}
	const retry = /try again in ([0-9]+\s*[a-z]+)/i.exec(message);
	return {
		code,
		scope: typeof scope === 'string' && SCOPES.includes(scope) ? (scope as RefusalScope) : null,
		retryIn: retry ? retry[1].replace(/\s+/g, '') : null,
	};
}

/** The sentence for a refusal, for a person using SnoutData AI. */
export function refusalSentence(refusal: GatewayRefusal): string {
	if (refusal.code === 'rate_limit_exceeded') {
		if (refusal.scope === 'project') {
			return `SnoutData AI is busier than it can serve right now. Try again${refusal.retryIn ? ` in ${refusal.retryIn}` : ' in a moment'}.`;
		}
		return `That's more requests in a minute than your plan allows. Try again${refusal.retryIn ? ` in ${refusal.retryIn}` : ' in a moment'}.`;
	}
	switch (refusal.scope) {
		case 'project':
			return "SnoutData AI has reached its limit for today, which is ours and not yours: your own budget is untouched. Try again later.";
		case 'group':
			return "Your team's shared AI budget is used up for this billing period. It starts again with the next period, or your team's owner can raise it at snoutdata.com.";
		default:
			return "You've used up your AI budget for this period. Upgrade or manage your plan at snoutdata.com to keep using the assistant, or wait for it to reset.";
	}
}
