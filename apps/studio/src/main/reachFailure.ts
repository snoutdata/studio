/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Turn a transport failure into a sentence that names the fix, or undefined when the error is not
 * about reaching the server at all (a 404, a bad key, a model that does not exist).
 *
 * Shared by the generator's provider and the learning model's backend, so both can say the same
 * things: the four ways a self-hosted server goes wrong look identical unless we say which one it
 * was, and that is not a fact about generation.
 *
 * It exists because the obvious version of it was wrong. `netFetch` goes through Electron's net
 * stack, which reports `net::ERR_CONNECTION_REFUSED` and friends — NOT Node's `ECONNREFUSED` — and
 * `AbortSignal.timeout` reports neither. Matching only Node's vocabulary meant every friendly
 * message here was unreachable and what the user actually saw was
 * "Error invoking remote method '…': Error: net::ERR_CONNECTION_REFUSED".
 */
export interface ReachContext {
	/** The endpoint that was tried, so the message can name it. */
	url: string;
	/** True for a server the user runs themselves (Ollama), which changes the advice: a vendor
	 *  cannot be "started with OLLAMA_HOST=0.0.0.0". */
	selfHosted: boolean;
	/** What to call it when it is not self-hosted ("OpenAI"). */
	label: string;
}

export function explainReach(err: unknown, context: ReachContext): string | undefined {
	const message = err instanceof Error ? err.message : String(err);
	const { url, selfHosted, label } = context;
	const where = selfHosted ? `Ollama at ${url}` : label;

	if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(message)) {
		// The single most common remote mistake: Ollama defaults to 127.0.0.1, so a server that is
		// running perfectly still refuses everything from another machine. Say that, not "refused".
		return selfHosted
			? `Nothing is listening at ${url}. Check Ollama is running there, and that it was started with OLLAMA_HOST=0.0.0.0 so it accepts connections from other machines.`
			: `${label} refused the connection at ${url}.`;
	}
	if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
		return `The address ${url} could not be resolved. Check the host name.`;
	}
	if (/ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|TimeoutError|aborted due to timeout|The operation was aborted/i.test(message)) {
		// Distinguished from refusal on purpose: a timeout is a firewall or a wrong address, never a
		// stopped server, and telling someone to restart Ollama would send them the wrong way.
		return `${where} did not answer in time. Check the address is right and that a firewall is not blocking the port.`;
	}
	if (/ERR_UNSAFE_PORT/i.test(message)) {
		return `Port ${url.split(':').pop() ?? ''} cannot be used: the browser engine blocks it. Run the server on another port (Ollama's default is 11434).`;
	}
	if (/ERR_CERT|ERR_SSL|ERR_TLS|self.signed|unable to verify/i.test(message)) {
		return `The certificate at ${url} was not accepted. A self-signed certificate has to be trusted by this machine.`;
	}
	if (/^net::ERR_|fetch failed|Failed to fetch|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(message)) {
		return `Could not reach ${where} (${message}).`;
	}
	return undefined;
}
