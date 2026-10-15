/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { policyAppliesTo, principalLabel, type GrantScope, type PrincipalDraft, type PrincipalKind, type SecurityChange } from '../../../shared/engine';
import type { CapabilityContext, CapabilityHandler } from './registry';

/**
 * Users and privileges, for the assistant and for an external agent.
 *
 * Reads run freely: "who can reach this database" and "what can this account do" are questions
 * with no side effect, and they are exactly what someone asks before making a decision.
 *
 * Writes do NOT run. `propose_db_user` and `propose_db_access_change` open the Users & Privileges
 * review surface with the statements filled in, and a person presses the button. That is the same
 * rule as `open_table_designer` — the assistant proposes, the surface reviews, the user applies —
 * and it matters more here: a GRANT is not a query you can re-run to undo.
 *
 * No tool in this file accepts a password. The new-user tool deliberately stops one field short
 * and the user types it into the form, because a password handed to a tool has already travelled
 * through a chat message, a tool-call argument and the AI audit log to get here.
 */

function connectionOr(ctx: CapabilityContext, raw: unknown): { id: string; label: string } {
	const id = String(raw ?? '');
	const conn = ctx.snapshot().connections.find((c) => c.id === id);
	if (!conn) {
		throw new Error(`No connection with id "${id}". Call list_connections or get_app_state first.`);
	}
	if (!conn.connected) {
		throw new Error(`Connection "${conn.label}" is not connected. Connect it first.`);
	}
	return { id: conn.id, label: conn.label };
}

function stringList(raw: unknown): string[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

const SCOPES: GrantScope[] = ['column', 'table', 'schema', 'database', 'global'];

function grantScope(raw: unknown): GrantScope {
	const value = String(raw ?? 'table').toLowerCase();
	return (SCOPES as string[]).includes(value) ? value as GrantScope : 'table';
}

/** The shared argument shape of the grant/revoke tool, described once. */
const ACCESS_PARAMETERS = {
	type: 'object',
	properties: {
		connectionId: { type: 'string', description: 'The connection to change (see list_connections / get_app_state).' },
		action: { type: 'string', enum: ['grant', 'revoke'], description: 'Whether to give the privileges or take them away.' },
		user: { type: 'string', description: 'The user or role the privileges are for.' },
		host: { type: 'string', description: 'MySQL/MariaDB only: the host part of the account, e.g. "%" or "localhost". On MySQL the account is the name AND host together.' },
		scope: { type: 'string', enum: SCOPES, description: 'How wide the grant is. Use "table" for a single table, "column" for named columns of one table.' },
		database: { type: 'string', description: 'Database name, for a database-scope grant or to qualify a table on MySQL.' },
		schema: { type: 'string', description: 'Schema name, for a schema-scope grant or to qualify a table on Postgres / SQL Server / Oracle.' },
		table: { type: 'string', description: 'Table or view name, for a table-scope or column-scope grant.' },
		columns: { type: 'array', items: { type: 'string' }, description: 'Column names, for a column-scope grant.' },
		privileges: { type: 'array', items: { type: 'string' }, description: 'Privileges, e.g. ["SELECT", "INSERT"]. Use the engine\'s own names.' },
		withGrantOption: { type: 'boolean', description: 'Let the grantee pass this privilege on to others. Grant only.' },
	},
	required: ['connectionId', 'action', 'user', 'privileges'],
};

export const securityCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'list_db_users',
			title: 'List database users',
			description: 'List the users, roles and logins on a database connection, with what each one is (can it sign in, is it a superuser, is it disabled) and which roles it holds. Read-only. Some engines only let a connection see part of this; anything unreadable is reported in "warnings" rather than silently omitted.',
			parameters: {
				type: 'object',
				properties: {
					connectionId: { type: 'string', description: 'The connection to read (see list_connections / get_app_state).' },
				},
				required: ['connectionId'],
			},
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'schema',
			domain: 'security',
		},
		run: async (args, ctx) => {
			const conn = connectionOr(ctx, args.connectionId);
			const snapshot = await ctx.api.securityRead(conn.id);
			const principals = snapshot.principals.map((principal) => ({
				name: principal.name,
				host: principal.host,
				kind: principal.kind,
				canLogin: principal.canLogin,
				isSuperuser: principal.isSuperuser,
				disabled: principal.disabled,
				roles: [...principal.memberOf],
			}));
			return {
				ok: true,
				summary: `Read ${principals.length} user${principals.length === 1 ? '' : 's'} and role${principals.length === 1 ? '' : 's'} on "${conn.label}"`,
				data: { principals, warnings: [...snapshot.warnings] },
			};
		},
	},
	{
		spec: {
			name: 'list_db_grants',
			title: 'List database privileges',
			description: 'List the privileges granted on a database connection: who holds what, on which object, and at what scope. Filter to one account with "user" (and "host" on MySQL). Read-only. A grant marked deny is a SQL Server DENY, which overrides every grant the principal holds, including ones inherited from a role. Privileges a principal gets THROUGH a role are not expanded here: check the role itself with the same tool.',
			parameters: {
				type: 'object',
				properties: {
					connectionId: { type: 'string', description: 'The connection to read.' },
					user: { type: 'string', description: 'Optional: only privileges held by this user or role.' },
					host: { type: 'string', description: 'MySQL/MariaDB only: the host part of the account to filter by.' },
				},
				required: ['connectionId'],
			},
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'schema',
			domain: 'security',
		},
		run: async (args, ctx) => {
			const conn = connectionOr(ctx, args.connectionId);
			const user = typeof args.user === 'string' ? args.user.trim() : '';
			const host = typeof args.host === 'string' ? args.host.trim() : '';
			const snapshot = await ctx.api.securityRead(conn.id);
			const grants = snapshot.grants
				.filter((grant) => !user || grant.grantee === user)
				.filter((grant) => !host || (grant.granteeHost ?? '') === host)
				.map((grant) => ({
					grantee: grant.granteeHost ? `${grant.grantee}@${grant.granteeHost}` : grant.grantee,
					scope: grant.scope,
					database: grant.database,
					schema: grant.schema,
					object: grant.object,
					column: grant.column,
					privilege: grant.privilege,
					withGrantOption: grant.withGrantOption,
					deny: grant.deny === true,
				}));
			return {
				ok: true,
				summary: `Read ${grants.length} privilege${grants.length === 1 ? '' : 's'}${user ? ` for ${user}` : ''} on "${conn.label}"`,
				data: { grants, warnings: [...snapshot.warnings] },
			};
		},
	},
	{
		spec: {
			name: 'list_db_policies',
			title: 'List row policies, quotas and settings profiles',
			description: 'List the access objects that are NOT grants: row policies (which rows of a table an account may see), quotas (how much it may use in a window of time) and settings profiles (what its sessions run with). Read-only, and ClickHouse only today; other engines return an empty list. Ask this before concluding that an account can see a whole table: a grant says it may read the table, a row policy decides which rows come back. Filter with "user" to get only the policies acting on one account, which follows the roles it holds and honours an "everyone except" list.',
			parameters: {
				type: 'object',
				properties: {
					connectionId: { type: 'string', description: 'The connection to read.' },
					user: { type: 'string', description: 'Optional: only the policies that act on this user or role.' },
				},
				required: ['connectionId'],
			},
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'schema',
			domain: 'security',
		},
		run: async (args, ctx) => {
			const conn = connectionOr(ctx, args.connectionId);
			const user = typeof args.user === 'string' ? args.user.trim() : '';
			const snapshot = await ctx.api.securityRead(conn.id);
			const principal = user ? snapshot.principals.find((entry) => entry.name === user) : undefined;
			const policies = snapshot.policies
				.filter((policy) => !user || policyAppliesTo(policy, user, principal?.memberOf ?? []))
				.map((policy) => ({
					kind: policy.kind,
					name: policy.name,
					database: policy.database,
					table: policy.object,
					appliesTo: [...policy.appliesTo],
					appliesToEveryone: policy.appliesToAll,
					exceptFor: [...policy.exceptFor],
					detail: policy.detail,
					restrictive: policy.restrictive,
				}));
			return {
				ok: true,
				summary: `Read ${policies.length} polic${policies.length === 1 ? 'y' : 'ies'}${user ? ` acting on ${user}` : ''} on "${conn.label}"`,
				data: { policies, warnings: [...snapshot.warnings] },
			};
		},
	},
	{
		spec: {
			name: 'propose_db_user',
			title: 'Propose a new database user',
			consentLabel: 'Open the new-user form, filled in for you to review. Nothing runs until you approve it.',
			description: 'Open the Users & Privileges screen with the new-user form filled in. The user reviews it, TYPES THE PASSWORD THEMSELVES, and approves the statements. Do NOT ask for or pass a password: this tool has no field for one, deliberately, so it never reaches a chat message or a log. To also give the new account privileges, call propose_db_access_change afterwards.',
			parameters: {
				type: 'object',
				properties: {
					connectionId: { type: 'string', description: 'The connection to create the account on.' },
					name: { type: 'string', description: 'The account name.' },
					host: { type: 'string', description: 'MySQL/MariaDB only: the host the account may connect from, e.g. "%" or "localhost". Defaults to "%".' },
					kind: { type: 'string', enum: ['user', 'role', 'login'], description: 'What to create. "role" is a group of privileges that cannot sign in; "login" is a SQL Server server-level login.' },
					roles: { type: 'array', items: { type: 'string' }, description: 'Roles to grant the new account.' },
				},
				required: ['connectionId', 'name'],
			},
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			domain: 'security',
		},
		run: (args, ctx) => {
			const conn = connectionOr(ctx, args.connectionId);
			const name = String(args.name ?? '').trim();
			if (!name) {
				return { ok: false, summary: '', error: 'A name is required.' };
			}
			const kind = (['user', 'role', 'login'].includes(String(args.kind)) ? String(args.kind) : 'user') as PrincipalKind;
			const draft: PrincipalDraft = {
				kind,
				name,
				host: typeof args.host === 'string' && args.host.trim() ? args.host.trim() : undefined,
				memberOf: stringList(args.roles),
			};
			ctx.app.openSecurity(conn.id, { draft });
			return {
				ok: true,
				summary: `Opened the new-${kind} form for "${principalLabel(draft)}" on "${conn.label}". The user sets the password and approves it.`,
			};
		},
	},
	{
		spec: {
			name: 'propose_db_access_change',
			title: 'Propose a privilege change',
			consentLabel: 'Open the privileges review screen with these statements. Nothing runs until you approve it.',
			description: 'Open the Users & Privileges review screen showing the exact GRANT or REVOKE statements for a privilege change, for the user to read and approve. Nothing is run by this tool. Call list_db_users first to confirm the account exists (and, on MySQL, which host it belongs to).',
			parameters: ACCESS_PARAMETERS,
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			domain: 'security',
		},
		run: (args, ctx) => {
			const conn = connectionOr(ctx, args.connectionId);
			const user = String(args.user ?? '').trim();
			const privileges = stringList(args.privileges);
			if (!user) {
				return { ok: false, summary: '', error: 'A user or role is required.' };
			}
			if (privileges.length === 0) {
				return { ok: false, summary: '', error: 'At least one privilege is required.' };
			}
			const revoke = String(args.action ?? 'grant').toLowerCase() === 'revoke';
			const scope = grantScope(args.scope);
			const principal = { name: user, host: typeof args.host === 'string' && args.host.trim() ? args.host.trim() : undefined };
			const target = {
				scope,
				database: typeof args.database === 'string' && args.database.trim() ? args.database.trim() : undefined,
				schema: typeof args.schema === 'string' && args.schema.trim() ? args.schema.trim() : undefined,
				object: typeof args.table === 'string' && args.table.trim() ? args.table.trim() : undefined,
				columns: scope === 'column' ? stringList(args.columns) : undefined,
			};
			const change: SecurityChange = revoke
				? { kind: 'revoke', principal, target, privileges }
				: { kind: 'grant', principal, target, privileges, withGrantOption: args.withGrantOption === true };
			ctx.app.openSecurity(conn.id, { changes: [change] });
			return {
				ok: true,
				summary: `Opened the review screen: ${revoke ? 'revoke' : 'grant'} ${privileges.join(', ')} for ${principalLabel(principal)} on "${conn.label}"`,
			};
		},
	},
];
