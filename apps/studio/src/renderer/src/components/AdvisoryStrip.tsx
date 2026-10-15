/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_NAME } from '../../../shared/assistant';
import { useState } from 'react';
import { Icon } from './Icon';
import { type Advisory } from '../../../shared/engine';

interface AdvisoryStripProps {
	advisories: Advisory[];
	/** Hand this advisory's statement to the AI assistant (optimize prompt). */
	onAskAi(): void;
	/** Dismiss the strip for the current result. */
	onDismiss(): void;
}

/**
 * A non-blocking strip shown above the results grid when the post-run index/scan advisor
 * (query advisor, Pillar 2 Tier B) found something worth flagging on the query that just ran —
 * a full table scan, a filesort, a temp table. Each advisory can be expanded for the rationale;
 * a single "Ask AI to fix" button hands the statement to the assistant's optimize flow. The results
 * still render underneath; this only surfaces advice.
 */
export function AdvisoryStrip(props: AdvisoryStripProps): JSX.Element | null {
	const [expanded, setExpanded] = useState<number | null>(null);
	if (props.advisories.length === 0) {
		return null;
	}
	const warns = props.advisories.filter((a) => a.level === 'warn').length;
	return (
		<div className="advisory-strip" role="status">
			<div className="advisory-head">
				<Icon name="warning" />
				<span className="advisory-title">
					{warns > 0 ? "Performance advice" : "Query notes"} ({props.advisories.length})
				</span>
				<span className="spacer" />
				<button type="button" className="advisory-ai" onClick={props.onAskAi} title={`Ask ${ASSISTANT_NAME} to suggest an index or rewrite`}>
					<Icon name="sparkle" /> Ask {ASSISTANT_NAME} to fix
				</button>
				<button type="button" className="advisory-dismiss" onClick={props.onDismiss} title="Dismiss">
					<Icon name="close" />
				</button>
			</div>
			<ul className="advisory-list">
				{props.advisories.map((a, i) => (
					<li key={i} className={`advisory-item ${a.level}`}>
						<button type="button" className="advisory-msg" onClick={() => setExpanded(expanded === i ? null : i)}>
							<Icon name={expanded === i ? 'chevron-down' : 'chevron-right'} />
							<span>{a.message}</span>
						</button>
						{expanded === i && (
							<div className="advisory-detail">
								{a.rationale && <p>{a.rationale}</p>}
								{a.suggestedSql && (
									<pre className="advisory-sql"><code>{a.suggestedSql}</code></pre>
								)}
							</div>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
