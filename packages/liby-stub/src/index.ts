/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @snout/liby, as the open-source tree builds it: the names Studio imports from her, none of her.
// See README.md. Types are the subset of hers that Studio builds values of.

import { createElement, Fragment, type ReactNode } from 'react';

export type LibyMood = 'hello' | 'happy' | 'proud' | 'sad' | 'shrug' | 'thinking' | 'curious' | 'sleepy' | 'dizzy';

/** What happens to her, on any surface (the host adds its own events alongside). */
export type LibyEvent =
	| { kind: 'greet' }
	| { kind: 'reply-start' }
	| { kind: 'reply-done' }
	| { kind: 'reply-error' }
	| { kind: 'poke' }
	| { kind: 'idle' }
	| { kind: 'sleep' }
	| { kind: 'wake' };

export interface Point {
	x: number;
	y: number;
}

export interface LibyCall {
	topic: string;
	tip: boolean;
	targets: string[];
	line: string;
	mood: LibyMood;
	action?: { label: string; run: () => void };
	asked?: boolean;
}

export interface LibyAction {
	label: string;
	run: () => void;
}

export interface LibyHelp {
	line: string;
	mood: LibyMood;
	actions?: LibyAction[];
}

export interface LibyFact {
	label: string;
	value: string;
}

export interface LibyLook {
	place: string;
	root?: Element;
	facts?: LibyFact[];
}

export interface LibyTrip {
	id: string;
	kind: 'call' | 'greeting' | 'milestone';
	line: string;
	mood: LibyMood;
	action?: { label: string; run: () => void };
	targets?: string[];
	tip?: boolean;
	to?: Point;
	asked?: boolean;
	introduces?: boolean;
	data?: unknown;
}

export interface StageState {
	summon: null;
	queue: LibyTrip[];
}

export interface LibyHelper {
	selector: string;
	place(el: Element): string;
	help?(el: Element): LibyHelp | null;
}

export interface LibyHelpFound {
	help: LibyHelp | null;
	place: string;
	root: Element;
}

export interface LibySurface {
	kind: string;
	el: Element;
}

/** The app's side of her. The real interface has more members, all optional; with no Liby to give
 *  them to, the stub keeps only the one that names the app's events. */
export interface LibyHost<E extends { kind: string } = LibyEvent> {
	world?(happen: (event: E) => void): () => void;
}

export function Liby(_props: { paused?: boolean }): null {
	return null;
}

export function LibyProvider<E extends { kind: string }>({ children }: { host: LibyHost<E>; children?: ReactNode }): ReactNode {
	return children ?? null;
}

export function LibyArt(_props: { className?: string }): null {
	return null;
}

/** Where the official build draws her seen from above (a `0 0 120 100` box, inside a host drawing
 *  that places it): a neutral mark in the same flat style, a soft disc with the house spark in it. No
 *  butterfly; her drawing is not part of this tree. */
export function LibyFromAbove(): ReactNode {
	const x = 60;
	const y = 56;
	const s = 3;
	return createElement(
		Fragment,
		null,
		createElement('circle', { className: 'ill-tint', cx: x, cy: y, r: 34 }),
		createElement('path', {
			className: 'ill-spark',
			d: `M${x} ${y - 7 * s} Q${x + 1.4 * s} ${y - 1.4 * s} ${x + 7 * s} ${y} Q${x + 1.4 * s} ${y + 1.4 * s} ${x} ${y + 7 * s} Q${x - 1.4 * s} ${y + 1.4 * s} ${x - 7 * s} ${y} Q${x - 1.4 * s} ${y - 1.4 * s} ${x} ${y - 7 * s} Z`,
		}),
	);
}

export function libyCall(_call: LibyCall): boolean {
	return false;
}

export function libyMoment(_moment: Omit<LibyTrip, 'flight' | 'seq' | 'from'>): boolean {
	return false;
}

export function libySummon(_at: Point, _target: Element | null): void {}

export function libyClose(): void {}

export function libyOut(): boolean {
	return false;
}

export function libyHeard(_text: string): boolean {
	return false;
}

export function libyNap(): void {}

export function getStage(): StageState {
	return { summon: null, queue: [] };
}

export function helpAt(start: Element): LibyHelpFound {
	return { help: null, place: '', root: start };
}

export function registerLibyHelper(_helper: LibyHelper): () => void {
	return () => {};
}

export function trackAttention(): void {}

export function attentionSurface(): LibySurface | null {
	return null;
}
