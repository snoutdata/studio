/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AiCreditStatus } from '../shared/ai';

/** What a Snout Function call answers with (the client's `fn.call`). */
export interface InvokeResult {
	data: unknown;
	error: unknown;
}

/** How long the Account screen waits for the balance before showing none. */
export const CREDIT_BALANCE_TIMEOUT_MS = 10000;

/** The `ai-credits` answer as an {@link AiCreditStatus}, or null when nothing was bought or the
 *  answer is not three finite, non-negative numbers. */
export function parseCreditBalance(data: unknown): AiCreditStatus | null {
	if (!data || typeof data !== 'object') {
		return null;
	}
	const { balance, purchasedTotal, spend } = data as Record<string, unknown>;
	const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
	if (!ok(balance) || !ok(purchasedTotal) || !ok(spend) || purchasedTotal <= 0) {
		return null;
	}
	return { balance, purchasedTotal, spend };
}

/** The signed-in user's pay-as-you-go credit balance, as the account service computes it (the
 *  `ai-credits` Snout Function, called with the user's own session). The app never derives it from
 *  the gateway itself. Null on any failure, a timeout included, so the Account screen shows no
 *  balance rather than a figure it worked out. */
export async function readCreditBalance(
	invoke: (name: string) => PromiseLike<InvokeResult>,
	timeoutMs = CREDIT_BALANCE_TIMEOUT_MS,
): Promise<AiCreditStatus | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			Promise.resolve(invoke('ai-credits')),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
			}),
		]);
		return result.error ? null : parseCreditBalance(result.data);
	} catch {
		return null;
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}
