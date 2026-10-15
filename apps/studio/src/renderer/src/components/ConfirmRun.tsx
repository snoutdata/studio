/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect } from 'react';
import type { StatementHazard } from '../../../shared/engine';
import { Icon } from './Icon';

interface ConfirmRunProps {
	label: string;
	database?: string;
	verb: string;
	unfiltered: boolean;
	/** Ways this statement does something other than what it reads like (guard/statementHazards). */
	hazards?: StatementHazard[];
	/** The statement with every hazard's suggested rewrite applied. Offered as the primary action
	 *  when it differs from what was typed. */
	corrected?: string;
	onRunCorrected?(): void;
	onConfirm(): void;
	onCancel(): void;
}

/** Production write confirmation: shown before a destructive statement runs on prod. */
export function ConfirmRun(props: ConfirmRunProps): JSX.Element {
	const { onConfirm, onCancel } = props;
	const hazards = props.hazards ?? [];
	// A hazard means the statement almost certainly isn't the one that was meant, so Enter must not
	// fire the run: the user has to choose between the corrected form and what they typed.
	const enterConfirms = hazards.length === 0;
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') {
				onCancel();
			} else if (e.key === 'Enter' && enterConfirms) {
				onConfirm();
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onConfirm, onCancel, enterConfirms]);

	const target = `${props.label}${props.database ? ` / ${props.database}` : ''}`;
	const detail = props.unfiltered
		? `This ${props.verb} filters nothing (no WHERE clause, or one that is always true), so it will affect EVERY row on the production database "${target}".`
		: `This runs a ${props.verb} statement on the production database "${target}".`;
	const canCorrect = props.corrected !== undefined && props.onRunCorrected !== undefined;
	return (
		<div className="modal-backdrop" onClick={props.onCancel}>
			<div className="modal confirm" onClick={(e) => e.stopPropagation()}>
				<h2 className="danger">
					<Icon name="warning" />
					Run {props.verb} on PRODUCTION?
				</h2>
				<p className="confirm-detail">{detail}</p>
				{hazards.length > 0 && (
					<div className="confirm-hazards">
						{hazards.map((h, i) => (
							<div className="confirm-hazard" key={i}>
								<Icon name="alert" />
								<div>
									<p className="confirm-hazard-message">{h.message}</p>
									<p className="confirm-hazard-rationale">{h.rationale}</p>
								</div>
							</div>
						))}
						{canCorrect && (
							<pre className="confirm-hazard-sql"><code>{props.corrected}</code></pre>
						)}
					</div>
				)}
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={props.onCancel} autoFocus><Icon name="close" /> Cancel</button>
					{canCorrect
						? (
							<>
								<button type="button" className="secondary" onClick={props.onConfirm}><Icon name="play" /> Run as written</button>
								{/* The correction is only the DEFAULT action when the statement is filtered. On an
								    unfiltered UPDATE the corrected form is the more destructive of the two (it
								    assigns every column the user listed, across every row), so it stays a plain
								    secondary: fixing the typo must not be a one-click way to widen the blast radius. */}
								<button type="button" className={props.unfiltered ? 'secondary' : undefined} onClick={props.onRunCorrected}>
									<Icon name="play" /> Run corrected statement
								</button>
							</>
						)
						: <button type="button" className="danger" onClick={props.onConfirm}><Icon name="warning" /> Run on Production</button>}
				</div>
			</div>
		</div>
	);
}
