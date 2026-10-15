/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Startup instrumentation ("Startup is sacred").
//
// The rule that section already carries is about WORK: nothing non-essential may RUN before first
// paint. The leak it does not cover is REACHABILITY — a view that is merely `import`ed from App.tsx
// is parsed and evaluated on every launch whether or not the user ever opens it, so launch cost
// grows with every feature shipped rather than with the features a user actually uses. Marks make
// that cost visible; `e2e/startup.spec.ts` turns the visible number into one that fails a test when
// it moves, which is the only reason it stays paid back.
//
// A mark is a Date.now() into an array — deliberately cheaper than anything it measures.

export type StartupMark = 'entry' | 'render' | 'paint';

const marks: { name: StartupMark; at: number }[] = [];

// Captured at module evaluation, which is the first line of our own code to run in the renderer.
const origin = Date.now();

export function mark(name: StartupMark): void {
	if (marks.some((m) => m.name === name)) {
		return;
	}
	marks.push({ name, at: Date.now() });
}

/** Milliseconds from the renderer's first line of our code to each mark. */
export function timings(): Record<string, number> {
	const out: Record<string, number> = {};
	for (const m of marks) {
		out[m.name] = m.at - origin;
	}
	return out;
}

mark('entry');

// Read by e2e (and by hand in devtools) as `__snoutStartup()`.
(window as unknown as { __snoutStartup?: () => Record<string, number> }).__snoutStartup = timings;
