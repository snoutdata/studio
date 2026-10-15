/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';

import { Icon } from './Icon';
import type { CliSignInAnswer, CliSignInRequest } from '../../../shared/mcp';

/*
 * "The SnoutData CLI wants to use your account."
 *
 * A program on this computer, most often the `snoutdata` CLI mid-`init`, has asked the app's local
 * server for a credential rather than sending the person to a browser at the wrong moment. This is
 * the question. It borrows the agent action card's shape and classes on purpose: it is the same
 * kind of interruption, a thing outside the app asking to be let in, and two different-looking
 * cards for that would be two things to learn.
 *
 * Two things it has to say plainly, and both are refusals of an easier sentence:
 *
 *   * **What is created is a NEW token, not your sign-in**. The card names the token, in the
 *     exact words it will carry in `snoutdata tokens list`, so "and you can take it back" is
 *     something the reader can go and check rather than something we assert at them.
 *   * **This prompt is manners, not a lock**. Any program running as this user can already read
 *     what the app stores on this computer: `safeStorage` is DPAPI/Keychain and user-scoped, which
 *     is equally true for the agent console. So the card says SnoutData does not hand your sign-in
 *     over without asking, and it does NOT say that nothing could take it. The second sentence
 *     would be false, and a false reassurance on a consent card is worse than no card.
 *
 * There is no "always allow". An agent action repeats dozens of times in one task, which is what
 * earned that button on the other card; this happens once per tool per machine, so a standing yes
 * would buy nothing and cost the only moment a person ever sees it.
 */

interface CliSignInToastProps {
	request: CliSignInRequest;
	onAnswer(answer: CliSignInAnswer): void;
}

export function CliSignInToast({ request, onAnswer }: CliSignInToastProps): JSX.Element {
	const [remaining, setRemaining] = useState(Math.ceil(request.timeoutMs / 1000));

	// Count down in the card. Main is the authority on the deadline (it declines on its own timer);
	// this is only so the user can see that waiting is itself an answer.
	useEffect(() => {
		setRemaining(Math.ceil(request.timeoutMs / 1000));
		const timer = setInterval(() => setRemaining((seconds) => Math.max(0, seconds - 1)), 1000);
		return () => clearInterval(timer);
	}, [request.requestId, request.timeoutMs]);

	return (
		<div className="agent-action-toast" role="alertdialog" aria-live="assertive">
			<div className="agent-action-head">
				<Icon name="key" />
				<strong>Use your SnoutData account?</strong>
				<span className="spacer" />
				<span className="agent-action-clock" title="Refused automatically if you do not answer">{remaining}s</span>
			</div>
			{/* The client names itself, so it is shown as a claim (quoted) and never as a fact. */}
			<p className="agent-action-what">
				"{request.client}" on {request.machine} is asking for an access token for <strong>{request.email}</strong>
				{request.command ? <>, to run <code>{request.command}</code></> : null}.
			</p>
			<span className="agent-action-title">
				<Icon name="key" /> {request.tokenName}
			</span>
			<p className="agent-action-scope">
				<Icon name="info" />
				<span>
					Allowing creates that access token. Your sign-in itself is not handed over, and you can
					revoke the token any time with <code>snoutdata tokens revoke</code> or from the dashboard.
					This prompt is a courtesy rather than a lock: any program running as you on this computer
					can already read what SnoutData Studio keeps here.
				</span>
			</p>
			<div className="agent-action-actions">
				<button className="primary" onClick={() => onAnswer('allow')}><Icon name="key" /> Create the token</button>
				<span className="spacer" />
				<button className="secondary agent-action-decline" onClick={() => onAnswer('decline')}>Not now</button>
			</div>
		</div>
	);
}
