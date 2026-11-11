/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PsycheError } from '@snout/psyche-admin';

// A project's AI gateway (Psyche), as Studio calls it. The calls and their shapes are
// `@snout/psyche-admin`, the client the dashboard uses too; this file adds only what is Studio's:
// what may cross IPC, and a transport's answer. No rule lives here: every rule is Psyche's, and a
// refusal is Psyche's own sentence. Main reaches a Cloud project through the control plane and a
// Local one straight on this machine (`ProjectAccess.psyche`); the renderer reaches main over IPC.

export { PsycheAdmin, PsycheError, dollars, modelInput, modelPath, routeInput } from '@snout/psyche-admin';
export type {
	Budget, BudgetInput, Credential, CredentialInput, Grant, GrantInput, Group, KeyInput, Limit, LimitInput, Model, ModelInput, ModelInternet, Period, Price, Provider, ProviderInput,
	ProviderKind, Quota, Fits, MaxPrice, Route, RouteConstraints, RouteInput, RouteSort, UpstreamModel, Usage, UsageBy, UsageRow, Whom,
	Key as PsycheKey, NewKey as NewPsycheKey, Transport as PsycheTransport,
} from '@snout/psyche-admin';

export type PsycheMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A method that may cross IPC. */
export function isPsycheMethod(value: unknown): value is PsycheMethod {
	return value === 'GET' || value === 'POST' || value === 'PUT' || value === 'PATCH' || value === 'DELETE';
}

/**
 * An admin path that may be sent: under `admin/`, plain characters, no way back up. The same rule
 * as the control plane's relay, so a Local project is held to what a Cloud one is.
 */
export function psycheAdminPathAllowed(path: unknown): path is string {
	if (typeof path !== 'string' || path.length > 512 || !/^admin\/[A-Za-z0-9_\-./%]+(\?[A-Za-z0-9_\-.%=&:]*)?$/.test(path)) {
		return false;
	}
	return !path.split('?')[0].split('/').some((part) => part === '..' || part === '.' || part === '' || /%(2e|2f|5c)/i.test(part));
}

/** What `ProjectAccess.psyche` answers, as a transport's return or throw. */
export function psycheAnswer(response: { ok: boolean; status: number; body: unknown; error?: string; code?: string }): unknown {
	if (!response.ok) {
		throw new PsycheError(response.error ?? `The gateway answered ${response.status}.`, response.status, response.code);
	}
	return response.body;
}

/** Off, or still starting, is the ordinary answer of a gateway, not an error. */
export function notServing(error: unknown): boolean {
	return error instanceof PsycheError && (error.status === 404 || error.status === 502 || error.status === 0);
}
