/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect } from 'react';
import { Icon } from './Icon';

interface PreflightWarnModalProps {
	/** Estimated rows the planner says this query will scan. */
	rows: number;
	/** Table the heavy scan is on, when known. */
	table?: string;
	onRunAnyway(): void;
	onCancel(): void;
}

function formatRows(n: number): string {
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(1)}M`;
	}
	if (n >= 1_000) {
		return `${Math.round(n / 1_000)}k`;
	}
	return String(Math.round(n));
}

/**
 * Pre-flight scan warning: shown before a query the planner estimates will read a
 * very large number of rows actually runs, so the user is warned up front instead of after the
 * screen freezes. Cancel is the default (Esc); "Run anyway" (Enter) proceeds.
 */
export function PreflightWarnModal(props: PreflightWarnModalProps): JSX.Element {
	const { onRunAnyway, onCancel } = props;
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') {
				onCancel();
			} else if (e.key === 'Enter') {
				onRunAnyway();
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onRunAnyway, onCancel]);

	const where = props.table ? ` of ${props.table}` : '';
	return (
		<div className="modal-backdrop" onClick={props.onCancel}>
			<div className="modal confirm" onClick={(e) => e.stopPropagation()}>
				<h2 className="warn-title">
					<Icon name="warning" />
					Large scan ahead
				</h2>
				<p className="confirm-detail">
					The query planner estimates this reads about <b>{formatRows(props.rows)} rows</b>{where} with no
					index to narrow them. On a large table it may take a while and hold up the connection.
				</p>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={props.onCancel} autoFocus><Icon name="close" /> Cancel</button>
					<button type="button" onClick={props.onRunAnyway}><Icon name="play" /> Run anyway</button>
				</div>
			</div>
		</div>
	);
}
