/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TERMINAL_FONT_MAX, TERMINAL_FONT_MIN } from '../appSettings';
import type { AppSettings } from '../appSettings';
import type { CapabilityHandler, CapabilityContext } from './registry';

/**
 * Settings capabilities. `get_settings` is a read-only view (never secrets); `set_setting`
 * writes through a strict whitelist of safe keys, rejecting anything else, so the assistant
 * can't flip security-sensitive or unknown options. `set_setting` is `mutates` and `destructive`:
 * every call is approved on its own, with the setting and its new value on the card.
 */

type Validator = (value: unknown, ctx: CapabilityContext) => { ok: true } | { ok: false; error: string };

const boolKey = (key: keyof AppSettings): Validator => (value, ctx) => {
	if (typeof value !== 'boolean') {
		return { ok: false, error: `"${String(key)}" expects true or false.` };
	}
	ctx.app.setAppSetting(key, value as AppSettings[typeof key]);
	return { ok: true };
};

const numberKey = (key: keyof AppSettings, min: number, max: number): Validator => (value, ctx) => {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n) || n < min || n > max) {
		return { ok: false, error: `"${String(key)}" expects a number between ${min} and ${max}.` };
	}
	ctx.app.setAppSetting(key, n as AppSettings[typeof key]);
	return { ok: true };
};

/** The only settings the assistant may change, each with its own validation. */
const WHITELIST: Record<string, Validator> = {
	theme: (value, ctx) => {
		const v = String(value).toLowerCase();
		if (v !== 'dark' && v !== 'light') {
			return { ok: false, error: 'theme expects "dark" or "light".' };
		}
		ctx.app.setTheme(v === 'dark');
		return { ok: true };
	},
	keywordCase: (value, ctx) => {
		const v = String(value).toLowerCase();
		if (v !== 'preserve' && v !== 'upper' && v !== 'lower') {
			return { ok: false, error: 'keywordCase expects preserve, upper, or lower.' };
		}
		ctx.app.setAppSetting('keywordCase', v as AppSettings['keywordCase']);
		return { ok: true };
	},
	defaultLimit: numberKey('defaultLimit', 1, 100000),
	idleDisconnectMinutes: numberKey('idleDisconnectMinutes', 0, 1440),
	fontSize: numberKey('fontSize', 9, 28),
	terminalFontSize: numberKey('terminalFontSize', TERMINAL_FONT_MIN, TERMINAL_FONT_MAX),
	autoLimit: boolKey('autoLimit'),
	wordWrap: boolKey('wordWrap'),
	minimap: boolKey('minimap'),
	autoConnectOnSelect: boolKey('autoConnectOnSelect'),
	reconnectOnLaunch: boolKey('reconnectOnLaunch'),
	// Not `confirmOnProd`, nor anything else that is a guard rather than a preference: the prod
	// confirmation is what stands between a model and a destructive statement on production, and
	// an agent must never be able to switch off the question that would have asked about it.
};

export const settingsCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'get_settings',
			description: 'Read the user-changeable app preferences (editor, query, and connection behavior). Never returns secrets or API keys.',
			parameters: { type: 'object', properties: {} },
			domain: 'settings',
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: (_args, ctx) => {
			const s = ctx.snapshot().appSettings;
			return {
				ok: true,
				summary: 'Current preferences',
				data: {
					keywordCase: s.keywordCase,
					defaultLimit: s.defaultLimit,
					autoLimit: s.autoLimit,
					fontSize: s.fontSize,
					terminalFontSize: s.terminalFontSize,
					wordWrap: s.wordWrap,
					minimap: s.minimap,
					autoConnectOnSelect: s.autoConnectOnSelect,
					reconnectOnLaunch: s.reconnectOnLaunch,
					confirmOnProd: s.confirmOnProd,
					idleDisconnectMinutes: s.idleDisconnectMinutes,
					changeable: Object.keys(WHITELIST),
				},
			};
		},
	},
	{
		spec: {
			name: 'set_setting',
			consentLabel: 'Change one of your app settings.',
			title: 'Change a setting',
			description: 'Change one app preference. Allowed keys: theme (dark/light), keywordCase (preserve/upper/lower), defaultLimit, idleDisconnectMinutes, fontSize, terminalFontSize, autoLimit, wordWrap, minimap, autoConnectOnSelect, reconnectOnLaunch. Safety settings (the production confirmation) are not changeable here.',
			parameters: {
				type: 'object',
				properties: {
					key: { type: 'string', description: 'The preference to change.' },
					value: { description: 'The new value (boolean, number, or string depending on the key).' },
				},
				required: ['key', 'value'],
			},
			domain: 'settings',
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			destructive: true,
		},
		run: (args, ctx) => {
			const key = String(args.key ?? '');
			const validator = WHITELIST[key];
			if (!validator) {
				return { ok: false, summary: '', error: `"${key}" is not a changeable setting. Allowed: ${Object.keys(WHITELIST).join(', ')}.` };
			}
			const result = validator(args.value, ctx);
			return result.ok
				? { ok: true, summary: `Set ${key} to ${String(args.value)}` }
				: { ok: false, summary: '', error: result.error };
		},
	},
];
