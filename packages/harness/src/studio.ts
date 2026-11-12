/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @snout/harness/studio: SnoutData Studio's surface. The text its assistant is told that does not
// depend on the database or the screen (prompt sections, the words around the screen's state, the
// database tools' descriptions), and Studio's capabilities under the harness's tool contract.
// Studio is open source, so this is too. It builds on the core and the core never imports it.

import * as studioPrompt from './surface/studio/prompt.ts';
import * as studioScreen from './surface/studio/screen.ts';
import * as studioTools from './surface/studio/tools.ts';
import type { ToolDefinition } from './types.ts';

export { studioPrompt, studioScreen, studioTools };

/** A Studio capability as its descriptor declares it. Studio's `CapabilitySpec` is one. */
export interface StudioCapability {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	domain: string;
	mutates: boolean;
}

/** Why a call {@link capabilityTool} was told to ask about every time is asked about. */
export const ASKED_EVERY_TIME = 'asked every time';

/**
 * A Studio capability as a harness {@link ToolDefinition}. Studio keeps deciding which calls a
 * standing yes is never enough for (destructive or security-relevant ones, a call whose card shows
 * a change of destination): `askEveryTime` is that answer for one call, and when it says so no grant
 * covers the call.
 */
export function capabilityTool(capability: StudioCapability, askEveryTime: (args: Record<string, unknown>) => boolean = () => false): ToolDefinition {
	return {
		spec: { name: capability.name, description: capability.description, parameters: capability.parameters },
		domain: capability.domain,
		mutates: capability.mutates,
		alwaysAsk: (args) => (askEveryTime(args) ? ASKED_EVERY_TIME : null)
	};
}

/** Every surface value with its functions called on numbered placeholders, keys sorted. */
function rendered(value: unknown): unknown {
	if (typeof value === 'function') {
		return rendered((value as (...args: string[]) => unknown)(...Array.from({ length: value.length }, (_, i) => `{${i}}`)));
	}
	if (Array.isArray(value)) {
		return value.map(rendered);
	}
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, rendered((value as Record<string, unknown>)[key])])
		);
	}
	return value;
}

/** All of Studio's surface text, as one string. */
export function studioSurfaceText(): string {
	return JSON.stringify(rendered({ prompt: studioPrompt, screen: studioScreen, tools: studioTools }));
}

/**
 * A short fingerprint of {@link studioSurfaceText} (FNV-1a, 32 bits). A dev app reports the one it
 * was built with, so a tuning run can tell whether it is serving the candidate text it measures.
 */
export function studioSurfaceDigest(): string {
	const text = studioSurfaceText();
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}
