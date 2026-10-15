/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Suspense, lazy, type ComponentProps, type ComponentType, type ReactElement } from 'react';

/**
 * Code-splits a feature view out of the launch chunk.
 *
 * The app's launch cost used to grow with every feature SHIPPED rather than with the features a
 * user actually opens: every view was statically imported from App.tsx, so Data Flows, Snoutbot,
 * the monitors, the agent console and the whole settings tree were parsed on every launch even
 * for a user who opens none of them. Wrapping the import here makes the cost O(features used) —
 * the chunk is fetched the first time the view is rendered, which is the first time the user asks
 * for it, and never otherwise.
 *
 * The wrapper carries its own Suspense boundary so the call sites in App.tsx stay untouched: a
 * lazily-loaded view is used exactly like the statically-imported one it replaced. The fallback
 * follows the precedent already set by ChartView (existing utility classes, no new CSS).
 *
 * Only use this for a view that is NOT on the first-paint path. Something the first screen renders
 * would trade parse time for a fetch and a flash of fallback, which is a worse launch, not a
 * better one.
 *
 * The generic is over the COMPONENT (`T`), not over its props: inferring props through a nested
 * `Promise<{ default: ComponentType<P> }>` puts P in a contravariant position and TypeScript
 * resolves it to `never`, which silently turns every call site into an unchecked one. Inferring T
 * from the imported component keeps prop checking exact, at the cost of the two casts below, which
 * are why `ComponentType<any>` is the constraint here rather than a tighter type.
 */
export function lazyView<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): T {
	const Loaded = lazy(load) as ComponentType<ComponentProps<T>>;
	function LazyView(props: ComponentProps<T>): ReactElement {
		return (
			<Suspense fallback={<div className="muted pad small">Loading…</div>}>
				<Loaded {...props} />
			</Suspense>
		);
	}
	return LazyView as unknown as T;
}
