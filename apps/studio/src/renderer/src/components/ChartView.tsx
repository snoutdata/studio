/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Suspense, lazy, useRef, useState } from 'react';
import { Icon } from './Icon';
import { chartDataToCsv, type ChartSpec } from '../../../shared/chart';

/**
 * Renders a chart the assistant proposed (a parsed ```chart block) inline in the chat, with a
 * Save menu (PNG / SVG / CSV). The Recharts renderer is in a separate, lazy-loaded module so the
 * recharts/d3 weight stays off the boot path — a chat with no charts never loads it.
 */
const ChartCanvas = lazy(() => import('./ChartCanvas'));

/** A filename-safe stem from the chart title (or "chart"). */
function stemOf(title: string | undefined): string {
	const safe = (title ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
	return safe.length > 0 ? safe.toLowerCase() : 'chart';
}

/** Serialize the rendered chart's <svg> to standalone SVG text (with a background fill). */
function svgText(svg: SVGSVGElement, bg: string): string {
	const clone = svg.cloneNode(true) as SVGSVGElement;
	clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	const rect = svg.getBoundingClientRect();
	clone.setAttribute('width', String(Math.round(rect.width)));
	clone.setAttribute('height', String(Math.round(rect.height)));
	// A backing rect so the exported image isn't transparent (matters for PNG on dark themes).
	const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
	bgRect.setAttribute('width', '100%');
	bgRect.setAttribute('height', '100%');
	bgRect.setAttribute('fill', bg);
	clone.insertBefore(bgRect, clone.firstChild);
	return new XMLSerializer().serializeToString(clone);
}

/** Rasterize an SVG string to a base64 PNG (no data-URL prefix), at 2x for crispness. */
function svgToPngBase64(svg: string, width: number, height: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const scale = 2;
		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement('canvas');
			canvas.width = width * scale;
			canvas.height = height * scale;
			const ctx = canvas.getContext('2d');
			if (!ctx) {
				reject(new Error("Could not get a canvas context."));
				return;
			}
			ctx.scale(scale, scale);
			ctx.drawImage(img, 0, 0, width, height);
			resolve(canvas.toDataURL('image/png').split(',')[1]);
		};
		img.onerror = () => reject(new Error("Could not rasterize the chart."));
		img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
	});
}

export function ChartView({ spec }: { spec: ChartSpec }): JSX.Element {
	const bodyRef = useRef<HTMLDivElement>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const [saving, setSaving] = useState(false);

	function readVar(name: string, fallback: string): string {
		const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
		return v || fallback;
	}

	async function save(format: 'png' | 'svg' | 'csv'): Promise<void> {
		setMenuOpen(false);
		const stem = stemOf(spec.title);
		try {
			setSaving(true);
			if (format === 'csv') {
				await window.sqlApi.saveChart(`${stem}.csv`, 'csv', chartDataToCsv(spec));
				return;
			}
			const svg = bodyRef.current?.querySelector('svg');
			if (!svg) {
				return;
			}
			const bg = readVar('--bg', '#1f1f1f');
			const xml = svgText(svg, bg);
			if (format === 'svg') {
				await window.sqlApi.saveChart(`${stem}.svg`, 'svg', xml);
				return;
			}
			const rect = svg.getBoundingClientRect();
			const png = await svgToPngBase64(xml, Math.round(rect.width), Math.round(rect.height));
			await window.sqlApi.saveChart(`${stem}.png`, 'png', png);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="chart-block">
			<div className="chart-block-head">
				<span className="chart-block-title"><Icon name="graph" /> {spec.title ?? "Chart"}</span>
				<div className="chart-block-tools">
					<button type="button" className="icon-btn" aria-label="Save chart" disabled={saving} onClick={() => setMenuOpen((o) => !o)}>
						<Icon name={saving ? 'loading' : 'save'} className={saving ? 'codicon-modifier-spin' : ''} />
					</button>
					{menuOpen && (
						<div className="chart-save-menu" onMouseLeave={() => setMenuOpen(false)}>
							<button type="button" onClick={() => void save('png')}><Icon name="file-media" /> Save as PNG</button>
							<button type="button" onClick={() => void save('svg')}><Icon name="file-media" /> Save as SVG</button>
							<button type="button" onClick={() => void save('csv')}><Icon name="file" /> Save data as CSV</button>
						</div>
					)}
				</div>
			</div>
			<div className="chart-block-body" ref={bodyRef}>
				<Suspense fallback={<div className="muted pad small">Loading chart…</div>}>
					<ChartCanvas spec={spec} />
				</Suspense>
			</div>
		</div>
	);
}
