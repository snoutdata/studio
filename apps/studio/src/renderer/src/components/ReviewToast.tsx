/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CSSProperties } from 'react';
import { useEffect } from 'react';

import type { ReviewToastState } from '../reviewRuns';
import { Icon } from './Icon';

interface ReviewToastProps {
	state: ReviewToastState;
	/** Positioning override, so it clears the activity bar and sidebar like the update card does. */
	style?: CSSProperties;
	/** Open the reviews view on this run. */
	onOpen(runId: string): void;
	onDismiss(): void;
}

/*
 * Snoutbot's card, bottom right, in the same family as the auto-update one.
 *
 * It exists because the reviewer was silent for the entire time it worked. "Check now" started a
 * poll that fetched a diff, introspected a schema and counted rows on a real database, and the
 * only sign of any of it was a tray reading nobody was looking at. A review is the slowest thing
 * this app does on somebody else's behalf, which makes it the one that most needs to say so.
 *
 * Two states, and the difference matters. `running` has NO auto-dismiss: it is replaced by the
 * result for the same review, because a spinner that disappears on a timer while the work carries
 * on is worse than no spinner. `done` goes after nine seconds like every other toast, and carries
 * the one action worth having in a card this size: read it.
 */
export function ReviewToast({ state, style, onOpen, onDismiss }: ReviewToastProps): JSX.Element {
	const done = state.phase === 'done';
	useEffect(() => {
		if (!done) {
			return;
		}
		const timer = setTimeout(onDismiss, 9000);
		return () => clearTimeout(timer);
	}, [done, state.label, onDismiss]);

	return (
		<div
			className={`update-toast review-toast${done ? ` tone-${state.tone}` : ' running'}`}
			role="status"
			style={style}
			data-test="review-toast"
		>
			<Icon
				name={done ? iconFor(state.tone) : 'sync'}
				className={`update-toast-icon${done ? '' : ' spin'}`}
			/>
			<span className="update-toast-text">
				<b>{state.label}</b>
				<span className="review-toast-detail">
					{state.phase === 'running' ? 'Snoutbot is reviewing this change' : state.text}
				</span>
			</span>
			{done ? (
				<span className="update-toast-actions">
					<button className="update-toast-action" type="button" onClick={() => onOpen(state.runId)}><Icon name="eye" /> 
						{state.awaiting ? 'Read it' : 'Open'}
					</button>
					<button className="update-toast-close" type="button" onClick={onDismiss} title="Dismiss">
						<Icon name="close" />
					</button>
				</span>
			) : (
				<button className="update-toast-close" type="button" onClick={onDismiss} title="Dismiss">
					<Icon name="close" />
				</button>
			)}
		</div>
	);
}

function iconFor(tone: 'ok' | 'warn' | 'error'): string {
	switch (tone) {
		case 'error': return 'error';
		case 'warn': return 'warning';
		default: return 'check';
	}
}
