/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { t } from './i18n/core';

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
			return refusal.retryIn ? t('engineShared.gateway.busyIn', { time: refusal.retryIn }) : t('engineShared.gateway.busy');
		}
		return refusal.retryIn ? t('engineShared.gateway.rateIn', { time: refusal.retryIn }) : t('engineShared.gateway.rate');
	}
	switch (refusal.scope) {
		case 'project':
			return t('engineShared.gateway.projectLimit');
		case 'group':
			return t('engineShared.gateway.teamBudget');
		default:
			return t('engineShared.gateway.userBudget');
	}
}
