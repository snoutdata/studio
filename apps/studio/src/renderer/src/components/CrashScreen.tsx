/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Icon } from './Icon';

/*
 * The last thing between a renderer exception and a black window.
 *
 * Without this, a single throw during render unmounts the whole tree and the user is left looking
 * at the app's background colour with no way to tell a crash from a layout bug, and nothing to
 * report. That is the worst failure mode this app has, and it is one component to remove it.
 *
 * It does NOT try to recover: React cannot be trusted to re-render the subtree that just threw.
 * It shows what happened, offers a reload, and lets the error reach the console (and Sentry's
 * global handler) unchanged.
 */

interface CrashScreenState {
	error: Error | null;
	stack: string;
}

export class CrashScreen extends Component<{ children: ReactNode }, CrashScreenState> {
	state: CrashScreenState = { error: null, stack: '' };

	static getDerivedStateFromError(error: Error): Partial<CrashScreenState> {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		// Straight to the console, unswallowed: DevTools is where this gets diagnosed.
		console.error('[snoutdata] the interface crashed', error, info.componentStack);
		this.setState({ stack: `${error.stack ?? error.message}\n\nComponent stack:${info.componentStack ?? ''}` });
	}

	render(): ReactNode {
		const { error, stack } = this.state;
		if (!error) {
			return this.props.children;
		}
		return (
			<div className="crash-screen">
				<div className="crash-card">
					<Icon name="error" />
					<h2>The interface stopped drawing</h2>
					<p>
						Something in the window threw an error, so it was taken down rather than left half
						painted. Your connections, queries and files are untouched: they live in the app, not
						in this window.
					</p>
					<pre className="crash-detail">{stack || error.message}</pre>
					<div className="crash-actions">
						<button className="primary" type="button" onClick={() => window.location.reload()}><Icon name="refresh" /> Reload the window</button>
						<button
							type="button"
							onClick={() => void navigator.clipboard.writeText(stack || error.message)}
						>
							<Icon name="copy" /> Copy the details
						</button>
					</div>
				</div>
			</div>
		);
	}
}
