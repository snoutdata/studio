/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CSSProperties } from 'react';
import { formatBytes } from '../formatBytes';
import type { ClusterMark, ClusterMapModel } from '../../../shared/cloudClusterMap';

/**
 * The Cluster section's map: `clusterMapModel`'s marks and lines as an SVG, every colour a theme
 * token (`.cluster-map` in styles.css). Solid lines carry queries from the router; dashed ones are a
 * copy following what it copies. A node's fill is its shade beside the keyspaces' range bars, so the
 * two read as one. It draws only: what each mark says is the model's.
 */

const SLOT = 172;
const ROW = 146;
const TOP = 30;
const RADIUS = 17;
/** About what fits under a mark at the map's small size; longer words go on a second line. */
const LINE_CHARS = 26;

function wrap(text: string): string[] {
	if (text.length <= LINE_CHARS) {
		return [text];
	}
	const cut = text.lastIndexOf(' ', LINE_CHARS);
	return cut <= 0 ? [text] : [text.slice(0, cut), text.slice(cut + 1)];
}

function centre(mark: ClusterMark): { x: number; y: number } {
	return { x: SLOT / 2 + mark.column * SLOT, y: TOP + mark.row * ROW };
}

/** Where a mark's words end, so a line leaving it downward never crosses them. */
function textBottom(mark: ClusterMark): number {
	return centre(mark).y + RADIUS * mark.scale + 31 + (wrap(mark.words).length - 1) * 13 + (mark.bytes !== null ? 13 : 0) + 8;
}

/** A line between two marks: down from under the upper one's words to the top of the lower one's mark. */
function linePath(from: ClusterMark, to: ClusterMark): { d: string; x: number; y: number } {
	const a = centre(from);
	const b = centre(to);
	const y1 = textBottom(from);
	const y2 = b.y - RADIUS * to.scale - 4;
	const bend = (y2 - y1) / 2;
	return { d: `M ${a.x} ${y1} C ${a.x} ${y1 + bend}, ${b.x} ${y2 - bend}, ${b.x} ${y2}`, x: (a.x + b.x) / 2 + 6, y: (y1 + y2) / 2 };
}

export function ClusterMap(props: { model: ClusterMapModel; shadeOf(catalogId: number): number }): JSX.Element {
	const { model } = props;
	const width = model.columns * SLOT;
	const height = TOP + (model.rows - 1) * ROW + 96;
	const byId = new Map(model.marks.map((m) => [m.id, m]));
	const described = model.marks.map((m) => `${m.label}: ${m.words}${m.bytes !== null ? `, ${formatBytes(m.bytes)} of data` : ''}`).join('. ');
	return (
		<div className="cluster-map">
			<p className="field-hint">{model.sentence}</p>
			<div className="cluster-map-frame">
				<svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={`${model.sentence} ${described}.`}>
					{model.lines.map((line) => {
						const from = byId.get(line.from);
						const to = byId.get(line.to);
						if (!from || !to) {
							return null;
						}
						const path = linePath(from, to);
						return (
							<g key={`${line.from}>${line.to}`} className={`cluster-map-line ${line.kind}`}>
								<path d={path.d} />
								{line.words && <text x={path.x} y={path.y} className="cluster-map-line-words">{line.words}</text>}
							</g>
						);
					})}
					{model.marks.map((mark) => {
						const { x, y } = centre(mark);
						const r = RADIUS * mark.scale;
						const words = wrap(mark.words);
						const style = mark.catalogId !== null ? ({ '--shade': `${props.shadeOf(mark.catalogId)}%` } as CSSProperties) : undefined;
						return (
							<g key={mark.id} className={`cluster-map-mark ${mark.role} ${mark.tone}${mark.pending ? ' pending' : ''}`} style={style}>
								<circle cx={x} cy={y} r={r} />
								<text x={x} y={y + r + 16} className="cluster-map-label">{mark.label}</text>
								{words.map((line, i) => (
									<text key={i} x={x} y={y + r + 31 + i * 13} className="cluster-map-words">{line}</text>
								))}
								{mark.bytes !== null && <text x={x} y={y + r + 31 + words.length * 13} className="cluster-map-size">{formatBytes(mark.bytes)} of data</text>}
							</g>
						);
					})}
				</svg>
			</div>
			<div className="cluster-map-legend small muted">
				<span><svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" className="cluster-map-key queries" /></svg>queries from the router</span>
				<span><svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" className="cluster-map-key follows" /></svg>a copy that follows</span>
			</div>
		</div>
	);
}
