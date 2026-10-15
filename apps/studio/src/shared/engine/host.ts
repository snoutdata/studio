/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Host services — the impure capabilities the engine is HANDED, and never imports.
 *
 *  The engine is pure, isomorphic TypeScript (see `index.ts`). Anything that touches the
 *  filesystem, the OS keychain, the network, or the clock lives in main and is passed in
 *  behind one of the interfaces below. That is what lets the same engine code run in the
 *  renderer, in main, and in the server child.
 *
 *  The security-relevant one is `SecretPresence`. The engine is allowed to know WHETHER a
 *  credential is set, so it can reason about a connection ("this one needs a password you
 *  have not supplied"), but it is never handed the value. No engine signature accepts a
 *  resolved secret, and `invariants.test.ts` asserts that this file declares no way to
 *  obtain one. That is the boundary the "your passwords never reach the model" claim rests
 *  on, so keep it narrow: if you find yourself wanting to widen `SecretPresence`, the work
 *  belongs on the main side of the boundary instead.
 *--------------------------------------------------------------------------------------------*/

import type { AiAuditEntry } from '../ai';

/**
 * Whether a credential exists, never what it is. Deliberately has no `get`: the engine
 * reasons about presence, main resolves values and hands the driver a config the engine
 * has already vetted.
 */
export interface SecretPresence {
	has(connectionId: string, kind: 'password' | 'sshPassword' | 'sshPassphrase' | 'awsSecretAccessKey'): boolean;
}

/**
 * The sink every mediated action is recorded to. The engine decides WHAT is recorded;
 * main provides the durable store (today `auditStore` → `userData/aiAudit.json`).
 */
export interface AuditSink {
	append(entry: AiAuditEntry): void;
}

/**
 * Injected so engine behaviour is deterministic under test. Engine code must not call
 * `Date.now()` or `Math.random()` directly.
 */
export interface Clock {
	now(): number;
}

/** Everything the engine needs from its host, in one object. */
export interface EngineHost {
	secrets: SecretPresence;
	audit: AuditSink;
	clock: Clock;
}
