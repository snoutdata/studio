/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Entitlements, Tier } from '../shared/auth';

// The single source of truth for what each tier unlocks. Keeping the tier → features map
// here (rather than in the database) means moving a feature behind the gate is a code change,
// not a migration: the profiles table only stores the tier name.
const TIERS: Record<Tier, Entitlements> = {
	// Agentic mode is no longer plan-gated: any signed-in user gets it (being signed in is the
	// only gate, enforced by the chat composer + aiService). AI audit logging is no longer
	// plan-gated either: everyone can record their own model round-trips.
	free: { aiLogging: true, agentMode: true, byok: false, scheduledFlows: false },
	plus: { aiLogging: true, agentMode: true, byok: true, scheduledFlows: true },
	pro: { aiLogging: true, agentMode: true, byok: true, scheduledFlows: true },
	// A seat on the business plan gets everything pro gets, and no flag of its own here. A shared
	// AI pool is a property of the TEAM, not of this tier.
	business: { aiLogging: true, agentMode: true, byok: true, scheduledFlows: true },
};

/** The entitlements a tier unlocks (defaults to the free set for an unknown tier). */
export function entitlementsForTier(tier: Tier): Entitlements {
	return TIERS[tier] ?? TIERS.free;
}

/** Coerce a raw tier value (from `get_my_effective_tier`, or anywhere untrusted) to a known tier;
 *  anything unexpected (null, a typo, a future tier this build doesn't know) becomes free.
 *
 *  It reads the keys of {@link TIERS} rather than listing the paid tiers by hand, so that adding a
 *  rung to `Tier` (which the compiler forces into that map) cannot leave this behind. It had been
 *  a hand-written `=== 'plus' || === 'pro'`, and a tier missing from a list like that is not
 *  ranked low, it is silently read back as FREE. */
export function normalizeTier(value: string | null | undefined): Tier {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TIERS, value) ? (value as Tier) : 'free';
}
