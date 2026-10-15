/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';

import { Icon } from './Icon';
import type { AgentActionRequest, AgentApproval } from '../../../shared/agentConsole';

/*
 * "Claude Code wants to open a new tab."
 *
 * The assistant asks for this inside its own chat turn, where the question sits in the
 * conversation that raised it. An external agent has no turn, so the question has to stand on its
 * own, which is what this is: a card the user answers, with the clock visibly running down.
 *
 * "Always allow" is offered PER ACTION, never as a blanket yes. The original note here said we
 * would not offer it at all; what changed is the evidence: an agent doing real work calls the same
 * few actions dozens of times in one task, so asking every time is not a safety feature, it is a
 * feature nobody leaves on. A standing yes to `open_query_tab` is a small, named, revocable thing
 * (Settings, Agent access lists every one and revokes it), and it is the same shape the assistant's
 * own "Always allow <connection>" already has.
 */

interface AgentActionToastProps {
	request: AgentActionRequest;
	onAnswer(answer: AgentApproval): void;
}

export function AgentActionToast({ request, onAnswer }: AgentActionToastProps): JSX.Element {
	const [remaining, setRemaining] = useState(Math.ceil(request.timeoutMs / 1000));

	// Count down in the card. Main is the authority on the deadline (it declines on its own timer);
	// this is only so the user can see that waiting is itself an answer.
	useEffect(() => {
		setRemaining(Math.ceil(request.timeoutMs / 1000));
		const timer = setInterval(() => setRemaining((seconds) => Math.max(0, seconds - 1)), 1000);
		return () => clearInterval(timer);
	}, [request.callId, request.timeoutMs]);

	return (
		<div className="agent-action-toast" role="alertdialog" aria-live="assertive">
			<div className="agent-action-head">
				<Icon name="shield" />
				<strong>{request.client} wants to change the app</strong>
				<span className="spacer" />
				<span className="agent-action-clock" title="Declined automatically if you do not answer">{remaining}s</span>
			</div>
			<p className="agent-action-what">{request.description}</p>
			{/* The action as a person says it, which is also how Settings' allowed-actions list names
			    it, so "Always allow this" and the row it ticks are recognisably the same thing. */}
			<span className="agent-action-title">{request.title}</span>
			{/* What THIS call changes, so the user approves the change and not only the action's name. */}
			{request.changes && request.changes.length > 0 && (
				<ul className="agent-action-changes">
					{request.changes.map((line) => <li key={line}>{line}</li>)}
				</ul>
			)}
			{request.note && <p className="agent-action-scope agent-action-note"><Icon name="warning" /> {request.note}</p>}
			{/* The answer here is bigger than the action when app changes are off, and the card has to
			    say so before the buttons rather than after. Saying yes turns the feature on; the
			    switch is in Settings either way, and a no stops the asking. */}
			{request.turnsOnAppChanges && (
				<p className="agent-action-scope">
					<Icon name="info" /> Letting an agent change the app is switched off. Allowing this turns it on,
					and each action still asks you. Settings, Agent access has the switch, and saying no here stops the asking.
				</p>
			)}
			<div className="agent-action-actions">
				<button className="primary" onClick={() => onAnswer('once')}><Icon name="check" /> Allow once</button>
				{request.allowAlways && (
					<button
						className="secondary agent-action-always"
						title={`Stop asking before "${request.title}". You can take this back in Settings, Agent access.`}
						onClick={() => onAnswer('always')}
					>
						<Icon name="check-all" /> Always allow this
					</button>
				)}
				<span className="spacer" />
				<button className="secondary agent-action-decline" onClick={() => onAnswer('decline')}><Icon name="circle-slash" /> Decline</button>
			</div>
		</div>
	);
}
