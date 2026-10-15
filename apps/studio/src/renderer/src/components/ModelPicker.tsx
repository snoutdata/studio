/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { isByokProvider } from '../../../shared/ai';
import type { AiModelInfo } from '../../../shared/ai';

interface ModelPickerProps {
	/** Models to offer, in display order (already filtered to enabled + the current selection). */
	models: AiModelInfo[];
	/** The active "provider:model" value. */
	current: string;
	/** Persist a new "provider:model" selection. */
	onChange(value: string): void;
	/** Called when the menu opens, so the caller can refresh the live model list. */
	onOpen?(): void;
	disabled?: boolean;
}

/** Where to anchor the portal-rendered menu: pinned to the button's top-right corner, growing up
 *  and to the left (the composer sits at the bottom-right of the app). */
interface MenuAnchor {
	right: number;
	bottom: number;
}

/** "provider:model" value for a model. */
function valueOf(m: AiModelInfo): string {
	return `${m.provider}:${m.model}`;
}

/** The label shown on a row / the button: the friendly display name when set, else the raw id. */
function nameOf(m: AiModelInfo): string {
	return m.displayName?.trim() || m.model;
}

/** "32768" → "32K context"; null when no window is known. */
function contextLabel(tokens: number | undefined): string | null {
	if (!tokens || tokens <= 0) {
		return null;
	}
	// Million-token windows read as "1000K" on the K scale, so switch units at 1M.
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M context`;
	}
	return `${Math.round(tokens / 1000)}K context`;
}

/** A short hint about how fast the model spends the paid wallet. Derived from the gateway price
 *  (bucketed into a usage weight server-side), so it stays correct as models change. */
function costHint(m: AiModelInfo): string {
	// BYOK runs on the user's own key, billed by their provider, not our wallet — so the
	// wallet buckets don't apply.
	if (isByokProvider(m.provider)) {
		return 'Your key';
	}
	switch (m.usageWeight) {
		case 'heavy': return 'Uses more of your balance';
		case 'normal': return 'Uses your balance';
		// Priced at $0 by the gateway, so it does not draw down the balance. Not "unlimited":
		// every tier is metered by a dollar wallet.
		default: return 'Included';
	}
}

/** The runtime chat-model picker: a custom dropdown (the native <select> can't show per-row
 *  sub-labels or a hover detail flyout). Each row shows the model name, a speed/power label, a
 *  Recommended tag, and a wallet hint; hovering a row opens a flyout with the description
 *  and context window. The menu is rendered in a portal so it escapes the composer's
 *  `overflow: hidden` clip. Metadata comes from the control plane via aiProviderStatus. */
export function ModelPicker({ models, current, onChange, onOpen, disabled }: ModelPickerProps): JSX.Element {
	const [open, setOpen] = useState(false);
	const [hovered, setHovered] = useState<string | null>(null);
	const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	// Anchor the menu to the button's top-right, in viewport coordinates (the menu is `fixed`).
	const reposition = useCallback((): void => {
		const el = btnRef.current;
		if (!el) {
			return;
		}
		const r = el.getBoundingClientRect();
		setAnchor({ right: window.innerWidth - r.right, bottom: window.innerHeight - r.top + 4 });
	}, []);

	// Close on a click outside both the button and the (portaled) menu, or on Escape; keep the
	// menu pinned to the button as the window resizes/scrolls.
	useEffect(() => {
		if (!open) {
			return;
		}
		function onDown(e: MouseEvent): void {
			const t = e.target as Node;
			if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) {
				setOpen(false);
			}
		}
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') {
				setOpen(false);
			}
		}
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		window.addEventListener('resize', reposition);
		window.addEventListener('scroll', reposition, true);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
			window.removeEventListener('resize', reposition);
			window.removeEventListener('scroll', reposition, true);
		};
	}, [open, reposition]);

	const active = models.find((m) => valueOf(m) === current);
	const detail = models.find((m) => valueOf(m) === hovered) ?? active;

	function toggle(): void {
		if (disabled) {
			return;
		}
		if (!open) {
			onOpen?.();
			reposition();
		}
		setOpen((o) => !o);
	}

	function pick(m: AiModelInfo): void {
		onChange(valueOf(m));
		setOpen(false);
	}

	return (
		<div className="model-picker">
			<button
				type="button"
				ref={btnRef}
				className="model-picker-btn"
				disabled={disabled}
				title="Choose the chat model"
				onClick={toggle}
			>
				<span className="model-picker-name">{active ? nameOf(active) : 'no models'}</span>
				{active?.label && <span className="model-picker-label">{active.label}</span>}
				{active?.reasoning && <span className="model-picker-reason" title="Reasoning (thinking) model">✦</span>}
				<Icon name="chevron-down" />
			</button>
			{open && anchor && createPortal(
				<div
					className="model-picker-menu"
					role="listbox"
					ref={menuRef}
					style={{ right: anchor.right, bottom: anchor.bottom }}
				>
					{models.length === 0 && <div className="model-picker-empty muted small">No models. Set one in AI settings.</div>}
					{models.map((m) => {
						const v = valueOf(m);
						return (
							<button
								type="button"
								role="option"
								aria-selected={v === current}
								key={v}
								className={`model-picker-row${v === current ? ' selected' : ''}`}
								onMouseEnter={() => setHovered(v)}
								onFocus={() => setHovered(v)}
								onClick={() => pick(m)}
							>
								<span className="model-picker-row-name">{nameOf(m)}</span>
								{m.label && <span className="model-picker-row-label">{m.label}</span>}
								{m.recommended && <span className="model-picker-tag">Recommended</span>}
								<span className="spacer" />
								{v === current && <Icon name="check" />}
							</button>
						);
					})}
					{detail && (
						<div className="model-picker-flyout">
							<div className="model-picker-flyout-name">{nameOf(detail)}</div>
							{detail.description && <div className="model-picker-flyout-desc">{detail.description}</div>}
							<div className="model-picker-flyout-meta">
								{contextLabel(detail.contextWindow) && <span>{contextLabel(detail.contextWindow)}</span>}
								<span className={detail.metered ? 'metered' : 'free'}>{costHint(detail)}</span>
								{detail.reasoning && <span>Reasoning model</span>}
							</div>
						</div>
					)}
				</div>,
				document.body,
			)}
		</div>
	);
}
