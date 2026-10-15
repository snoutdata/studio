/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { helpShortcutDescription } from '@snout/liby/studio';
import { ASSISTANT_NAME } from '../../../shared/assistant';
import type { CapabilityHandler } from './registry';

/**
 * Read-only orientation capabilities: the current app state (connections, which is active, open
 * tabs, key preferences) and the user's keyboard shortcuts. No prompt — they read nothing
 * sensitive (no secrets, no row data).
 */
export const appStateCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'get_app_state',
			description: 'Get the current state of the app: saved connections (and which are connected), the active connection, open editor tabs, and key preferences. Call this first to orient yourself before acting.',
			parameters: { type: 'object', properties: {} },
			domain: 'app',
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: (_args, ctx) => {
			const snap = ctx.snapshot();
			const connected = snap.connections.filter((c) => c.connected).length;
			return {
				ok: true,
				summary: `${snap.connections.length} connections (${connected} connected), ${snap.tabs.length} tabs`,
				data: {
					connections: snap.connections,
					activeConnectionId: snap.activeConnectionId,
					tabs: snap.tabs,
					preferences: {
						keywordCase: snap.appSettings.keywordCase,
						defaultLimit: snap.appSettings.defaultLimit,
						autoLimit: snap.appSettings.autoLimit,
						autoConnectOnSelect: snap.appSettings.autoConnectOnSelect,
						wordWrap: snap.appSettings.wordWrap,
					},
				},
			};
		},
	},
	{
		// On demand rather than in every prompt: most turns are about data, and the model fetches
		// this only when a question is about using the app.
		spec: {
			name: 'get_shortcuts',
			description: `Get the user's keyboard shortcuts in SnoutData Studio, exactly as they are bound now (they can rebind them), and how to call up the assistant (${ASSISTANT_NAME}). Call this when asked for a shortcut, how to do something in the app, or how to bring the assistant up; quote the keys exactly as returned.`,
			parameters: { type: 'object', properties: {} },
			domain: 'app',
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: (_args, ctx) => {
			const shortcuts = ctx.snapshot().shortcuts;
			const keysFor = (id: string): string | undefined => shortcuts.find((s) => s.id === id)?.keys;
			const help = keysFor('libyHelp');
			const palette = keysFor('commandPalette');
			const callAssistantHelp = [
				`the ${ASSISTANT_NAME} panel (this chat)`,
				help ? helpShortcutDescription(help) : '',
				`the command palette${palette ? ` (${palette})` : ''}, command "${ASSISTANT_NAME}: Help Me Here"`,
			].filter(Boolean);
			return {
				ok: true,
				summary: `${shortcuts.length} shortcuts`,
				data: { shortcuts: shortcuts.map((s) => ({ action: s.label, keys: s.keys })), callAssistantHelp, rebind: 'Settings, Shortcuts' },
			};
		},
	},
];
