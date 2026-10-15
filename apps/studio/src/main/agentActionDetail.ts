/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { asksEveryTime, type CapabilitySpec } from '../shared/capabilities';
import type { ConnectionConfig, SshTunnelProfile } from '../shared/connection';
import { describeConnectionEdit, describeTestDestination, describeTunnelEdit, DESTINATION_CHANGE_NOTE, formatChange, SAFETY_CHANGE_NOTE, testDestinationNote, TUNNEL_MOVE_NOTE } from '../shared/connectionDestination';
import { MONITOR_QUERY_CAPABILITIES } from './monitorAgentGate';

/*---------------------------------------------------------------------------------------------
 *  What an external agent's call would do, for the approval card.
 *
 *  The card used to carry the action's title and nothing else for every action but
 *  `edit_connection`, so "Delete a cloud project" was approved without saying WHICH project, and
 *  "Change a setting" without saying which setting or to what. A person approves the call in front
 *  of them, so every app-changing call now lists its arguments, and a destructive or
 *  security-relevant one (`asksEveryTime`) never offers a standing yes.
 *
 *  Pure, so it is tested without Electron; `main/index.ts` hands it the saved connections.
 *--------------------------------------------------------------------------------------------*/

/** What one call would do, beyond its action's name. */
export interface AgentActionDetail {
	changes?: string[];
	note?: string;
	/** Ask even when the user said "always" to this action, and do not offer "always" here. */
	askEveryTime?: boolean;
}

/** An argument whose value is a credential is shown as present, never printed. */
const SECRET_ARG = /pass(word|phrase)?|secret|token|api[_-]?key|private[_-]?key|credential/i;

/** What a card for a monitor's query says about it. */
export const MONITOR_NOTE = 'The app runs this query by itself on every interval, in the background, until the widget is removed. Only a read is run.';

/** How long one value may be on the card before it is cut. */
const MAX_VALUE = 120;

/** One argument as a person reads it. */
function formatValue(value: unknown): string {
	const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > MAX_VALUE ? `${flat.slice(0, MAX_VALUE - 3)}...` : flat;
}

/**
 * The arguments of a call, one `name: value` line each, in the order the capability declares
 * them (then any it did not declare, which a model can still send).
 */
export function describeArguments(spec: Pick<CapabilitySpec, 'parameters'>, args: Record<string, unknown>): string[] {
	const declared = Object.keys((spec.parameters as { properties?: Record<string, unknown> }).properties ?? {});
	const order = [...declared, ...Object.keys(args).filter((key) => !declared.includes(key))];
	const lines: string[] = [];
	for (const key of order) {
		const value = args[key];
		if (value === undefined || value === null || value === '') {
			continue;
		}
		lines.push(`${key}: ${SECRET_ARG.test(key) ? '(hidden)' : formatValue(value)}`);
	}
	return lines;
}

/** What happens to an external agent's call before it runs. */
export type AgentCallGate = { kind: 'run' } | { kind: 'ask' } | { kind: 'refuse'; error: string };

/** Why a call to a capability the renderer has not published is refused. */
export const UNPUBLISHED_CAPABILITY_MESSAGE = 'That app action is not available right now (the app window has not finished loading its actions). Try again in a moment.';

/**
 * Whether an external agent's call to `spec` runs, is asked about, or is refused. Approval was
 * asked only when the spec said it mutates, so a call that arrived while its spec was missing (the
 * window loading, or reloading, its actions) ran with no card. A spec that is not there is not
 * known to read only, so that call is refused: fail closed. `autoApproved` is the user's standing
 * "always allow" for this action.
 */
export function agentCallGate(spec: Pick<CapabilitySpec, 'mutates'> | undefined, detail: AgentActionDetail, autoApproved: boolean): AgentCallGate {
	if (!spec) {
		return { kind: 'refuse', error: UNPUBLISHED_CAPABILITY_MESSAGE };
	}
	if (spec.mutates && (detail.askEveryTime || !autoApproved)) {
		return { kind: 'ask' };
	}
	return { kind: 'run' };
}

export function agentActionDetail(
	spec: Pick<CapabilitySpec, 'name' | 'domain' | 'destructive' | 'parameters'>,
	args: Record<string, unknown>,
	connections: () => ConnectionConfig[],
	tunnels: () => SshTunnelProfile[] = () => [],
): AgentActionDetail {
	const always = asksEveryTime(spec);
	if (spec.name === 'edit_tunnel') {
		// A shared tunnel moved to another SSH server or user takes every connection through it there:
		// main drops the secrets that may not follow (connectionSecrets.ts), the new server's key is
		// trusted on first use, so the card names old → new and is asked every time.
		const existing = tunnels().find((entry) => entry.id === String(args.id ?? ''));
		if (existing) {
			const changes = describeTunnelEdit(existing, args);
			const moves = changes.some((change) => change.destination);
			const using = connections().filter((entry) => entry.sshTunnelRef === existing.id).map((entry) => entry.label);
			return {
				changes: [
					`tunnel: ${existing.name}`,
					...changes.map(formatChange),
					...(moves && using.length > 0 ? [`connections using it: ${using.join(', ')}`] : []),
				],
				note: moves ? TUNNEL_MOVE_NOTE : undefined,
				askEveryTime: moves || always,
			};
		}
		return { changes: describeArguments(spec, args), askEveryTime: true };
	}
	if (spec.name === 'edit_connection') {
		// Each field as `before → after`, and an edit that moves the connection (driver, host,
		// port, ssl) is asked every time: main drops the saved password on it, and a standing yes
		// must not cover pointing a connection somewhere new.
		// An edit to its environment or read-only (what makes it production, what lets it be written)
		// is asked every time too: a standing yes to renames must not cover switching a guard off.
		const existing = connections().find((entry) => entry.id === String(args.id ?? ''));
		if (existing) {
			const changes = describeConnectionEdit(existing, args);
			const moves = changes.some((change) => change.destination);
			const safety = changes.some((change) => change.safety);
			const notes = [moves ? DESTINATION_CHANGE_NOTE : '', safety ? SAFETY_CHANGE_NOTE : ''].filter((note) => note !== '');
			return {
				changes: [`connection: ${existing.label}`, ...changes.map(formatChange)],
				note: notes.length > 0 ? notes.join(' ') : undefined,
				askEveryTime: moves || safety || always,
			};
		}
		// A connection main does not know is still an edit someone could approve for later: asked.
		return { changes: describeArguments(spec, args), askEveryTime: true };
	}
	if (MONITOR_QUERY_CAPABILITIES.has(spec.name) && typeof args.sql === 'string') {
		// The query the app will run by itself, shown WHOLE (never cut at MAX_VALUE: the end of a
		// statement is where a second one goes), and the connection by name.
		const id = String(args.connectionId ?? '');
		const target = connections().find((entry) => entry.id === id);
		const { sql, connectionId: _connection, ...rest } = args;
		return {
			changes: [
				...describeArguments(spec, rest),
				`connection: ${target ? `${target.label}${target.environment ? ` (${target.environment})` : ''}` : id || '(none)'}`,
				`sql: ${String(sql).trim()}`,
			],
			note: MONITOR_NOTE,
			askEveryTime: true,
		};
	}
	if (spec.name === 'test_connection_settings') {
		// A destination the model chose. Shown whole (never cut at MAX_VALUE: the end of a hostname
		// is where it goes), and asked every time.
		return { changes: describeTestDestination(args), note: testDestinationNote(args), askEveryTime: true };
	}
	if (spec.name === 'set_setting') {
		return {
			changes: [`setting: ${formatValue(args.key ?? '')}`, `new value: ${formatValue(args.value)}`],
			askEveryTime: true,
		};
	}
	const changes = describeArguments(spec, args);
	return { changes: changes.length > 0 ? changes : undefined, askEveryTime: always };
}
