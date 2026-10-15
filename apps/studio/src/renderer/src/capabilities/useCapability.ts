/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react';
import { capabilityRegistry, type CapabilityHandler } from './registry';

/**
 * Register capabilities for the lifetime of a component. Use this from a module that owns
 * ephemeral state (e.g. a designer that's only open sometimes) so its capabilities appear in
 * the manifest only while it's mounted and tear down automatically. App-level capabilities that
 * are always available are registered directly against {@link capabilityRegistry} instead.
 *
 * Two things here are defensive, and both were paid for. `capabilityRegistry.register` THROWS on
 * a duplicate name, and a throw inside a passive effect takes the whole window down with it: the
 * results grid registering `filter_results` a second time is how the app went black after the
 * results panel was collapsed and reopened. So:
 *
 *  - **Clear our own names first.** React can run a mount effect whose previous cleanup has not
 *    run (StrictMode double-invokes on purpose). Only the names THIS hook registered are cleared,
 *    so a genuine collision between two different call sites is still loud.
 *  - **One bad name costs only itself.** A failure is logged and skipped rather than thrown, and
 *    it cannot leave a half-registered set behind to poison the next mount. The panel keeps
 *    working; that one capability is simply not offered.
 *
 * App.tsx does the same unregister-first dance for its static capabilities, for the same reason.
 */
export function useCapabilities(handlers: CapabilityHandler[]): void {
	const mine = useRef<string[]>([]);
	useEffect(() => {
		for (const name of mine.current) {
			capabilityRegistry.unregister(name);
		}
		mine.current = [];
		const unregisters: Array<() => void> = [];
		for (const handler of handlers) {
			try {
				unregisters.push(capabilityRegistry.register(handler));
				mine.current.push(handler.spec.name);
			} catch (error) {
				console.error('[snoutdata] capability not registered:', handler.spec.name, error);
			}
		}
		return () => {
			for (const off of unregisters) {
				off();
			}
			mine.current = [];
		};
		// Re-register only when the set of capability names changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [handlers.map((h) => h.spec.name).join(',')]);
}
