/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { ConnectionPicker } from './ConnectionPicker';
import type { ConnectionConfig } from '../../../shared/connection';
import {
	DEFAULT_LIGHT,
	DEFAULT_MATTER,
	OrbitScene,
	type OrbitHover,
	type OrbitLight,
	type OrbitMatter,
	type OrbitStats,
} from '../orbit/scene';
import { PALETTE_LABELS, resolvePalette, type PaletteId } from '../orbit/palette';
import { settleBudget } from '../../../shared/orbitLod';
import {
	buildOrbitGraph,
	condenseStatement,
	findNode,
	neighbourhood,
	searchNodes,
	statementPath,
	statementTargets,
	type OrbitGraph,
	type OrbitStatement,
} from '../../../shared/orbit';
import { redactSqlSecrets } from '../../../shared/engine';
import { createOrbitLayout } from '../../../shared/orbitLayout';
import type { DatabaseSchema } from '../../../shared/schema';
import {
	DEFAULT_PULSE_INTERVAL_MS,
	MIN_PULSE_INTERVAL_MS,
	type PulseSample,
	type PulseSupport,
} from '../../../shared/orbitPulse';

/*
 * Snout Orbit — the database as a 3D world.
 *
 * This component owns a canvas, a rail and an inspector. Everything three.js touches is behind
 * `OrbitScene`, and everything a test can reason about (what the graph IS, where it settles, which
 * tables a statement touched) is in `src/shared/orbit*.ts`. What is left here is React.
 *
 * It is reached ONLY through `lazyView()` in App.tsx, and it is the only thing in the app that
 * pulls in three.js. `e2e/startup.spec.ts` asserts both halves: the chunk exists separately, and a
 * launch never fetches it.
 *
 * Two per-frame jobs are deliberately not React's business. Labels are DOM nodes the scene writes
 * to directly, because doing that through state would re-render the tree sixty times a second.
 * Hover arrives as a callback that only fires when the hovered thing CHANGES.
 */

/** One entry in the rail's database picker: the connection itself, which the picker draws the
 *  way the editor toolbar's does, and whether it is open. */
export type OrbitConnection = ConnectionConfig & { connected: boolean };

interface OrbitViewProps {
	/** Whether the Orbit tab is the one on screen. False pauses the render loop. */
	active: boolean;
	/** The introspected schema of the active connection, or null when nothing is connected. */
	schema: DatabaseSchema | null;
	/** The connection Orbit is drawing, needed to ask the database what it is doing (Pulse 3b). */
	connectionId?: string;
	/** What to call the database in the header. */
	connectionLabel?: string;
	/** Every connection the user has, so Orbit can say which one it drew and fly to another. */
	connections?: OrbitConnection[];
	/** Point Orbit at a different database. Connects it first when it is not already open. */
	onSelectConnection?(id: string | undefined): void;
	/** The selected connection is being opened right now — the rail shows the spinner. */
	connecting?: boolean;
	/** It has just finished opening — the rail shows the brief check-mark, as the toolbar does. */
	connectedFlash?: boolean;
	/** Open the selected connection. Without this the rail can only wait for one to open itself. */
	onConnect?(id: string): void;
	/** Give up on a slow connect that is still in flight (best-effort abort in main). A connect
	 *  that hangs is the one the user most needs a way out of, and a bare spinner is not one. */
	onCancelConnect?(id: string): void;
	/** The last statement the app ran, for Pulse (3a). */
	statement?: OrbitStatement;
	/** Open a table in the results grid. */
	onOpenTable?(table: { name: string; schema?: string }): void;
	/** Focus request from the AI assistant or a coding agent. */
	focusRequest?: { table: string; nonce: number };
	/**
	 * Where the control rail is drawn. Orbit's canvas wants the whole tab, so the rail is portalled
	 * into the docked Orbit panel rather than floating over the world.
	 *
	 * Null means there is no panel to draw into, and then there is NO RAIL. It used to float on the
	 * canvas as a fallback "so the controls are never unreachable", which got the case backwards:
	 * the panel goes away when the user collapses it or shows another tool in that area, and both
	 * of those are someone asking for the world without the controls on top of it. Collapsing the
	 * sidebar left every slider sitting in the middle of the picture. The controls are reached by
	 * opening the panel again, from the activity bar or the palette, like every other tool window.
	 */
	railHost?: HTMLElement | null;
}

const LIGHT_CONTROLS: Array<{ key: keyof OrbitLight; label: string; min: number; max: number; step: number }> = [
	{ key: 'bloomStrength', label: "Bloom strength", min: 0, max: 3, step: 0.05 },
	{ key: 'bloomThreshold', label: "Bloom threshold", min: 0, max: 1, step: 0.01 },
	{ key: 'exposure', label: "Exposure", min: 0.3, max: 2, step: 0.05 },
];

const MATTER_CONTROLS: Array<{ key: keyof OrbitMatter; label: string; min: number; max: number; step: number }> = [
	{ key: 'nodeScale', label: "Node scale", min: 0.3, max: 2.5, step: 0.05 },
	{ key: 'linkOpacity', label: "Link opacity", min: 0, max: 1, step: 0.01 },
];

const PALETTE_IDS: PaletteId[] = ['theme', 'gold', 'tron', 'ember'];

/** Layout knobs live outside the scene because changing one re-wakes the simulation. */
interface WorldOptions {
	spread: number;
	gravity: number;
}

const DEFAULT_WORLD: WorldOptions = { spread: 380, gravity: 1.6 };

/**
 * How many statements the Pulse feed keeps. It is a HEADS-UP display over a moving picture, not a
 * log: five lines is what can be read at a glance, and the audit trail is the AI audit log and the
 * query history, both of which keep everything.
 */
const FEED_ROWS = 5;
/** Above this, a statement's duration is called out rather than just stated. */
const SLOW_MS = 400;

/**
 * How many matches the Find box offers.
 *
 * Capped on purpose: a substring of two characters matches half a real schema, and a list of nine
 * hundred names is a worse answer than the world itself, which is already showing every one of
 * them lit. The list is for landing on ONE table; the picture is for seeing how many there were.
 */
const SEARCH_MATCHES = 60;

interface FeedEntry {
	id: string;
	text: string;
	ms?: number;
	live?: boolean;
}

/**
 * What one statement reads as in the feed. Redacted FIRST: Pulse 3b shows what the DATABASE is
 * running, which is not necessarily something this user typed, and a `CREATE USER ... PASSWORD`
 * caught mid-flight would otherwise be painted across the screen.
 */
function feedText(sql: string): string {
	return condenseStatement(redactSqlSecrets(sql));
}

export function OrbitView(props: OrbitViewProps): JSX.Element {
	const {
		active, schema, connectionId, connectionLabel, connections, statement, focusRequest, railHost,
		connecting, connectedFlash, onSelectConnection, onConnect, onCancelConnect, onOpenTable,
	} = props;

	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const labelRef = useRef<HTMLDivElement | null>(null);
	const sceneRef = useRef<OrbitScene | null>(null);
	const graphRef = useRef<OrbitGraph | null>(null);

	const [light, setLight] = useState<OrbitLight>(DEFAULT_LIGHT);
	const [matter, setMatter] = useState<OrbitMatter>(DEFAULT_MATTER);
	const [world, setWorld] = useState<WorldOptions>(DEFAULT_WORLD);
	const [paletteId, setPaletteId] = useState<PaletteId>('theme');
	const [drift, setDrift] = useState(true);
	const [labels, setLabels] = useState(true);
	const [hover, setHover] = useState<OrbitHover>({ kind: null, id: -1 });
	const [focus, setFocus] = useState(-1);
	/** What is typed in the rail's Find box. Empty means the whole world is lit. */
	const [query, setQuery] = useState('');
	/** The match list is a popup, so it can be put away without clearing what was typed. */
	const [hitsDismissed, setHitsDismissed] = useState(false);
	/** Which row the keyboard is on, -1 for none. */
	const [hitIndex, setHitIndex] = useState(-1);
	const [feed, setFeed] = useState<FeedEntry[]>([]);
	// Pulse 3b: what the DATABASE is doing, as opposed to what this app ran. Off by default,
	// because it is a query against a database the user may be paying for by the read.
	const [pulseLive, setPulseLive] = useState(false);
	const [pulseInterval, setPulseInterval] = useState(DEFAULT_PULSE_INTERVAL_MS);
	const [pulseSupport, setPulseSupport] = useState<PulseSupport | null>(null);
	const [pulseError, setPulseError] = useState<string | null>(null);
	/** Sample ids already drawn, so a statement that runs for ten seconds fires once, not five times. */
	const seenSamples = useRef<Set<string>>(new Set());
	const [themeTick, setThemeTick] = useState(0);
	/**
	 * Why there is no world, when the window could not give Orbit a WebGL context at all: no GPU
	 * and no software fallback (a virtual machine, a GPU Chromium refuses), or hardware acceleration
	 * switched off. three.js throws from its constructor then, and uncaught, that took the WHOLE
	 * window down to "The interface stopped drawing" for one tab the user can simply close.
	 */
	const [sceneError, setSceneError] = useState<string | null>(null);

	const reducedMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);

	// The graph is rebuilt only when the schema itself changes: a re-render must never cost a
	// re-layout, and a schema refresh must.
	const graph = useMemo(() => (schema ? buildOrbitGraph(schema) : null), [schema]);
	graphRef.current = graph;

	const counts = useMemo(() => {
		if (!graph) {
			return null;
		}
		return {
			objects: graph.nodes.length,
			relations: graph.links.length,
			schemas: graph.clusters.length,
			foreignKeys: graph.links.filter((l) => l.kind === 'fk').length,
		};
	}, [graph]);

	/**
	 * A database with one schema is the common case (most MySQL, every SQLite), and two of the
	 * rail's knobs are meaningless there: with a single centroid, "cluster spread" only translates
	 * the whole world, and "schema gravity" resizes a ball the camera immediately normalises away.
	 * A control that visibly does nothing is worse than no control, so they are hidden rather than
	 * left to be fiddled with.
	 */
	const manySchemas = (graph?.clusters.length ?? 0) > 1;

	/** The connection Orbit is drawing, for the picker's status dot. */
	const activeConnection = connections?.find((connection) => connection.id === connectionId);

	// What the scene actually drew, which is not always what the schema holds (orbitLod.ts).
	const [stats, setStats] = useState<OrbitStats | null>(null);

	/* ----------------------------------------------------------------- scene */

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) {
			return;
		}
		let scene: OrbitScene;
		try {
			scene = new OrbitScene(canvas, reducedMotion);
		} catch (err) {
			console.warn(`[orbit] no WebGL context: ${err instanceof Error ? err.message : String(err)}`);
			setSceneError("This window could not start 3D graphics (WebGL), which Orbit draws with. It needs a working graphics driver, with hardware acceleration on (Settings, Appearance).");
			return;
		}
		setSceneError(null);
		scene.setLabelHost(labelRef.current);
		sceneRef.current = scene;
		const observer = new ResizeObserver(() => scene.resize());
		observer.observe(canvas);
		return () => {
			observer.disconnect();
			scene.dispose();
			sceneRef.current = null;
		};
	}, [reducedMotion]);

	// Hand the scene a database. The layout is warmed here rather than over the first few seconds
	// of frames, so Orbit opens on a formed galaxy instead of a cloud resolving itself.
	useEffect(() => {
		const scene = sceneRef.current;
		if (!scene || !graph) {
			return;
		}
		const layout = createOrbitLayout(graph, { spread: world.spread, gravity: world.gravity });
		// TIME-BOXED, not a fixed tick count. The benchmark found that per-frame work was never
		// Orbit's ceiling (60,000 objects cost 1.52ms of a 16.6ms frame even unoptimised) and that
		// THIS line was: a flat settle(320) is 4.9 seconds of an unresponsive window at 60k objects.
		// `settleBudget` spends about 250ms whatever the schema costs, with a floor so a small one
		// still settles properly.
		layout.settle(settleBudget(graph.nodes.length, graph.links.length));
		scene.setGraph(graph, layout);
		setStats(scene.stats());
		setFocus(-1);
		setQuery('');
		setHitIndex(-1);
		setHover({ kind: null, id: -1 });
	}, [graph, world.spread, world.gravity]);

	useEffect(() => {
		const scene = sceneRef.current;
		if (!scene) {
			return;
		}
		scene.onHover = setHover;
		scene.onPick = (picked) => {
			const current = graphRef.current;
			if (!current) {
				return;
			}
			if (picked.kind === 'node') {
				isolate(picked.id);
				return;
			}
			if (picked.kind === 'link') {
				// Clicking a relation follows it: isolate whichever end you were not already on.
				const link = current.links[picked.id];
				isolate(focus === link.a ? link.b : link.a);
				return;
			}
			clearFocus();
		};
		// `isolate` and `clearFocus` are stable enough for this: they only read refs and setState.
	});

	useEffect(() => {
		if (active) {
			sceneRef.current?.resize();
			sceneRef.current?.start();
		} else {
			sceneRef.current?.stop();
		}
	}, [active]);

	/*
	 * The HUD's numbers are live, and three of them (packets in flight, draw calls, frame rate)
	 * change every frame. They are POLLED at 2Hz rather than pushed, because a state update per
	 * frame would re-render this tree sixty times a second to move five digits, and because a
	 * frame-rate readout that changes sixty times a second cannot be read anyway.
	 */
	useEffect(() => {
		if (!active || !graph) {
			return;
		}
		const timer = window.setInterval(() => {
			const scene = sceneRef.current;
			if (scene) {
				setStats(scene.stats());
			}
		}, 500);
		return () => window.clearInterval(timer);
	}, [active, graph]);

	useEffect(() => { sceneRef.current?.setLight(light); }, [light]);
	useEffect(() => { sceneRef.current?.setMatter(matter); }, [matter]);
	useEffect(() => { sceneRef.current?.setDrift(drift); }, [drift]);
	useEffect(() => { sceneRef.current?.setLabelsVisible(labels); }, [labels]);

	// Ink (a light theme) draws nodes as discs, bigger than a glowing point, so the labels stand
	// further off them (styles.css, `.orbit-labels.ink`).
	const [ink, setInk] = useState(false);
	useEffect(() => {
		const palette = resolvePalette(paletteId, getComputedStyle(document.documentElement));
		setInk(palette.ink);
		sceneRef.current?.setPalette(palette);
	}, [paletteId, themeTick, graph]);

	// The theme is stamped on <html data-theme>, so watching that attribute is the whole of
	// "follow the app's theme" — no event bus, no prop drilled down from App.
	useEffect(() => {
		const observer = new MutationObserver(() => setThemeTick((n) => n + 1));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
		return () => observer.disconnect();
	}, []);

	/* ---------------------------------------------------------------- focus */

	const isolate = useCallback((id: number): void => {
		const current = graphRef.current;
		if (!current || id < 0) {
			return;
		}
		setFocus(id);
		sceneRef.current?.setFocus(id, neighbourhood(current, id, 1));
	}, []);

	/** Drop the isolated neighbourhood without touching the camera or the search. */
	const clearFocus = useCallback((): void => {
		setFocus(-1);
		sceneRef.current?.setFocus(-1, null);
	}, []);

	/**
	 * Escape is RESET, not just deselect. Clearing the isolation on its own left the camera
	 * wherever the last fly had parked it, often inside a corner of a schema with the whole
	 * database dark around it and no way back but scrolling out by hand. It now clears the
	 * isolation, clears the search, and flies the camera back to the opening frame.
	 */
	const resetWorld = useCallback((): void => {
		setFocus(-1);
		setQuery('');
		setHitIndex(-1);
		sceneRef.current?.setFocus(-1, null);
		sceneRef.current?.setSpotlight(null);
		sceneRef.current?.resetView();
	}, []);

	useEffect(() => {
		function onKey(event: KeyboardEvent): void {
			if (event.key === 'Escape') {
				resetWorld();
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [resetWorld]);

	useEffect(() => {
		if (!focusRequest || !graph) {
			return;
		}
		const id = findNode(graph, focusRequest.table);
		if (id >= 0) {
			isolate(id);
		}
	}, [focusRequest, graph, isolate]);

	/* ---------------------------------------------------------------- search */

	/** Which objects the typed name matches. Recomputed only when the name or the database moves. */
	const matches = useMemo(() => (graph ? searchNodes(graph, query, SEARCH_MATCHES) : []), [graph, query]);

	/** Whether the match list is up: something typed, and not put away. */
	const hitsOpen = query.trim() !== '' && !hitsDismissed;

	/** Isolate a match and put the list away, which is what picking one is for. */
	const pickHit = useCallback((id: number): void => {
		setHitsDismissed(true);
		setHitIndex(-1);
		isolate(id);
	}, [isolate]);

	/**
	 * The list's keyboard, and the one place two meanings of Escape have to be told apart.
	 *
	 * With the list up, Escape closes the LIST and stops there: the press must not also fly the
	 * camera home, which is what the window-level handler would do with it. `stopPropagation` is
	 * what keeps it from getting there, so this is a real dependency and not a tidy-up.
	 */
	function onFindKey(event: React.KeyboardEvent<HTMLInputElement>): void {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			if (matches.length === 0) {
				return;
			}
			event.preventDefault();
			setHitsDismissed(false);
			const step = event.key === 'ArrowDown' ? 1 : -1;
			setHitIndex((current) => Math.max(-1, Math.min(matches.length - 1, current + step)));
			return;
		}
		if (event.key === 'Escape' && hitsOpen) {
			event.preventDefault();
			event.stopPropagation();
			setHitsDismissed(true);
			setHitIndex(-1);
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			// The highlighted row, or the top one: typing a whole name and then having to reach
			// for the arrow keys is a step for nothing.
			const chosen = matches[hitIndex] ?? matches[0];
			if (chosen !== undefined) {
				pickHit(chosen);
			}
		}
	}

	/**
	 * Light the matches and their direct neighbours, and dim everything else.
	 *
	 * An isolated table OWNS the dim, so this stands down while one is focused and takes over
	 * again the moment it is cleared, which is why `focus` is a dependency and not just a guard.
	 */
	useEffect(() => {
		const scene = sceneRef.current;
		const current = graphRef.current;
		if (!scene || focus >= 0) {
			return;
		}
		if (!current || matches.length === 0) {
			scene.setSpotlight(null);
			return;
		}
		const lit = new Set<number>();
		for (const id of matches) {
			for (const near of neighbourhood(current, id, 1)) {
				lit.add(near);
			}
		}
		scene.setSpotlight(lit);
	}, [matches, focus]);

	/* ----------------------------------------------------------------- pulse */

	useEffect(() => {
		const scene = sceneRef.current;
		const current = graphRef.current;
		if (!scene || !current || !statement) {
			return;
		}
		const targets = statementTargets(current, statement.sql);
		if (targets.length === 0) {
			return;
		}
		for (const target of targets) {
			scene.touch(target);
		}
		const path = statementPath(current, targets);
		if (path.length > 0) {
			scene.firePath(path);
		}
		setFeed((previous) => [
			{ id: `app:${statement.at}`, text: feedText(statement.sql), ms: statement.durationMs },
			...previous,
		].slice(0, FEED_ROWS));
	}, [statement]);

	/* -------------------------------------------------------- pulse: the database */

	// Ask whether this engine even HAS an activity view before offering the switch, so a SQLite
	// user is told why rather than shown a toggle that does nothing.
	useEffect(() => {
		let cancelled = false;
		setPulseSupport(null);
		if (!connectionId) {
			return;
		}
		void window.sqlApi.orbitPulseSupported(connectionId).then((support) => {
			if (!cancelled) {
				setPulseSupport(support);
			}
		}).catch(() => undefined);
		return () => { cancelled = true; };
	}, [connectionId]);

	// Start and stop with the switch, and STOP when Orbit closes: main keeps sampling until it is
	// told not to, and a poller left running against someone's production database because a tab
	// was closed is exactly the thing the opt-in was for.
	useEffect(() => {
		if (!connectionId || !pulseLive) {
			return;
		}
		let stopped = false;
		void window.sqlApi.orbitPulseStart(connectionId, pulseInterval).then((started) => {
			if (!stopped && !started.started) {
				setPulseError(started.reason ?? "The database would not report its activity.");
				setPulseLive(false);
			}
		}).catch(() => undefined);
		return () => {
			stopped = true;
			void window.sqlApi.orbitPulseStop(connectionId).catch(() => undefined);
		};
	}, [connectionId, pulseLive, pulseInterval]);

	useEffect(() => {
		const off = window.sqlApi.onOrbitPulse((id, samples: PulseSample[]) => {
			const scene = sceneRef.current;
			const current = graphRef.current;
			if (!scene || !current || id !== connectionId) {
				return;
			}
			const fresh = samples.filter((sample) => !seenSamples.current.has(sample.id));
			for (const sample of fresh) {
				seenSamples.current.add(sample.id);
				const targets = statementTargets(current, sample.sql);
				for (const target of targets) {
					scene.touch(target);
				}
				const path = statementPath(current, targets);
				if (path.length > 0) {
					scene.firePath(path);
				}
				if (targets.length > 0) {
					setFeed((previous) => [
						{ id: sample.id, text: feedText(sample.sql), ms: sample.durationMs, live: true },
						...previous,
					].slice(0, FEED_ROWS));
				}
			}
			// The seen set is bounded by forgetting anything not in this poll: a statement that has
			// finished can never come back with the same id.
			seenSamples.current = new Set(samples.map((sample) => sample.id));
		});
		const offStatus = window.sqlApi.onOrbitPulseStatus((id, error) => {
			if (id === connectionId) {
				setPulseError(error);
			}
		});
		return () => { off(); offStatus(); };
	}, [connectionId]);

	/* ------------------------------------------------------------- inspector */

	const inspector = useMemo(() => {
		if (!graph) {
			return null;
		}
		const target: OrbitHover = hover.kind ? hover : focus >= 0 ? { kind: 'node', id: focus } : { kind: null, id: -1 };
		if (target.kind === 'node') {
			const node = graph.nodes[target.id];
			return {
				kind: node.kind.toUpperCase(),
				name: node.name,
				path: node.schema + (node.parent !== undefined ? ` / on ${graph.nodes[node.parent].name}` : ''),
				rows: [
					['columns', String(node.columns)],
					[node.kind === 'index' ? 'covers rows' : 'rows', node.rows === undefined ? '-' : node.rows.toLocaleString()],
					['foreign keys', String(node.fkDegree)],
					['relations', String(node.degree)],
				] as Array<[string, string]>,
				hint: focus === target.id ? "Isolated. Press esc to clear." : "Click to isolate its neighbourhood.",
				table: node.kind === 'index' || node.kind === 'routine' ? undefined : { name: node.name, schema: node.schema },
			};
		}
		if (target.kind === 'link') {
			const link = graph.links[target.id];
			const a = graph.nodes[link.a];
			const b = graph.nodes[link.b];
			return {
				kind: link.kind === 'fk' ? 'FOREIGN KEY' : link.kind === 'index' ? 'INDEX' : 'DEPENDENCY',
				name: link.name,
				path: link.kind === 'fk' && link.columns ? `${a.schema}.${a.name}.${link.columns.join(', ')}` : `on ${a.schema}.${a.name}`,
				rows: link.kind === 'fk'
					? [
						['references', `${b.schema}.${b.name}`],
						['columns', (link.referencedColumns ?? []).join(', ') || '-'],
						['scope', link.crossSchema ? "cross schema" : "in schema"],
					] as Array<[string, string]>
					: [
						['object', b.name],
						['kind', b.kind],
						['on', `${a.schema}.${a.name}`],
					] as Array<[string, string]>,
				hint: "Click to follow it.",
				table: undefined,
			};
		}
		return null;
	}, [graph, hover, focus]);

	/* ------------------------------------------------------------------ HUD */

	/** The rail goes into the docked panel, or nowhere at all. */
	function renderRail(rail: JSX.Element): JSX.Element | null {
		return railHost ? createPortal(rail, railHost) : null;
	}

	return (
		<div className="orbit-view">
			<canvas className="orbit-canvas" ref={canvasRef} />
			<div className={`orbit-labels${ink ? ' ink' : ''}`} ref={labelRef} />

			{/*
			  * The tab is already called Orbit and the rail is already headed by it, so the wordmark
			  * over the world was the product's name printed on the user's data. What is left is the
			  * one thing the canvas cannot say for itself: which database this is.
			  */}
			<header className="orbit-lockup">
				<p>{connectionLabel ? connectionLabel : "Connect a database to see it here."}</p>
			</header>

			{renderRail(
				<aside className="orbit-rail">
				{/*
				  * Which database this IS comes first, because every number below it is about that
				  * database and nothing else in the rail says which one. It is the editor toolbar's
				  * own `ConnectionPicker`, not a control of Orbit's:
				  * choosing a connection is the same act here as it is up there, so it should be the
				  * same thing on screen.
				  *
				  * Which is why it is NOT a card with a "Database" label over it any more. A card
				  * makes it one setting among Light, Matter and Pulse, and it is not a setting: it
				  * is what the whole panel is about, so it reads as the panel's head — an accent
				  * rule under it rather than a box around it — and looks like the picker the user
				  * already knows from above the editor. It carries that picker's three states too,
				  * and it had NONE of them: an unopened connection sat there saying "(not
				  * connected)" with nothing to press, which on a lazily-opened database is the most
				  * likely reason the world is empty.
				  */}
				<section className="orbit-conns">
					<ConnectionPicker
						connections={connections ?? []}
						isConnected={(id) => connections?.some((connection) => connection.id === id && connection.connected) === true}
						value={connectionId}
						onChange={(id) => onSelectConnection?.(id)}
						noneLabel="No connection"
						title="Connection Orbit is drawing"
					/>
					{connectionId !== undefined && connecting && (
						<span className="connect-inflight">
							<span className="icon-btn connecting" aria-label="Connecting…"><Icon name="loading" className="codicon-modifier-spin" /></span>
							<button type="button" className="icon-btn cancel-connect" aria-label="Cancel connecting" onClick={() => onCancelConnect?.(connectionId)}><Icon name="stop-circle" /></button>
						</span>
					)}
					{connectionId !== undefined && !connecting && connectedFlash && (
						<span className="icon-btn connected-flash" aria-label="Connected"><Icon name="check" /></span>
					)}
					{connectionId !== undefined && !connecting && !connectedFlash && !activeConnection?.connected && (
						<button type="button" className="icon-btn" aria-label="Connect" onClick={() => onConnect?.(connectionId)}><Icon name="plug" /></button>
					)}
				</section>

				{/*
				  * Find a table by name, right under the database it belongs to, because the two
				  * questions are one question. The match is a substring on both sides ("us" finds
				  * `users` AND `status`), which is what someone half-remembering a name needs, and
				  * every match plus its direct neighbours is lit in the world while the rest dims:
				  * the list lands you on ONE table, the picture says how many there were.
				  *
				  * It is a COMBOBOX, not a field with a list under it. The rail is a column of
				  * controls and a list that grows inside it pushes Light, Matter and Pulse down the
				  * screen as you type, so the panel rearranges itself while you are reading it. The
				  * matches float over the groups below instead, the way the wizard's source palette
				  * does, and they are gone the moment you have picked one.
				  *
				  * It appears only when there is a database drawn. An empty search box over an
				  * empty world is a control that can only disappoint.
				  */}
				{graph && (
					<section className="orbit-group orbit-find">
						<span className="orbit-eyebrow">Find</span>
						{/* The popup hangs off THIS, not off the card, so it lines up with the field
						    rather than with the card's padding. */}
						<div className="orbit-find-anchor">
						<div className="orbit-find-box">
							<Icon name="search" />
							<input
								type="text"
								value={query}
								placeholder="Name contains..."
								aria-label="Find a table by name"
								role="combobox"
								aria-expanded={hitsOpen}
								aria-controls="orbit-find-matches"
								aria-activedescendant={hitIndex >= 0 ? `orbit-find-match-${hitIndex}` : undefined}
								onChange={(e) => { setQuery(e.target.value); setHitsDismissed(false); setHitIndex(-1); }}
								onFocus={() => setHitsDismissed(false)}
								onBlur={() => setHitsDismissed(true)}
								onKeyDown={onFindKey}
							/>
							{/* Says what Escape will do while the list is up, because up there it
							    closes the list rather than resetting the world. */}
							{hitsOpen && <span className="orbit-find-esc">Esc</span>}
							{query !== '' && !hitsOpen && (
								<button type="button" className="icon-btn" aria-label="Clear" onClick={() => setQuery('')}>
									<Icon name="close" />
								</button>
							)}
						</div>
						{hitsOpen && (
							/* mousedown, not click: the field must keep focus while a row is pressed,
							   or the list closes on blur before the click ever lands. */
							<div className="orbit-find-pop" onMouseDown={(event) => event.preventDefault()}>
								{matches.length === 0 && (
									<p className="orbit-find-empty">No table or view has that in its name.</p>
								)}
								<ul id="orbit-find-matches" role="listbox" aria-label="Matching tables">
									{matches.map((id, index) => (
										<li key={id}>
											<button
												type="button"
												id={`orbit-find-match-${index}`}
												role="option"
												aria-selected={index === hitIndex}
												className={index === hitIndex ? 'chosen' : undefined}
												ref={index === hitIndex ? ((node) => node?.scrollIntoView({ block: 'nearest' })) : undefined}
												onClick={() => pickHit(id)}
												title={`${graph.nodes[id].schema}.${graph.nodes[id].name}`}
											>
												<span className="orbit-hit-name">{graph.nodes[id].name}</span>
												{/*
												  * The schema, and only where there is more than one of them.
												  * Two tables can share a name across schemas, and a list that
												  * cannot tell them apart is a list you cannot pick from. On a
												  * single-schema database it says the same word on every row.
												  */}
												{manySchemas && <span className="orbit-hit-meta">{graph.nodes[id].schema}</span>}
											</button>
										</li>
									))}
								</ul>
								{matches.length === SEARCH_MATCHES && (
									<p className="orbit-find-empty">The first {SEARCH_MATCHES}. Type more of the name to narrow it.</p>
								)}
							</div>
						)}
						</div>
					</section>
				)}

				<section className="orbit-group">
					<span className="orbit-eyebrow">Light</span>
					{LIGHT_CONTROLS.map((control) => (
						<label className="orbit-ctl" key={control.key}>
							<span className="orbit-ctl-row">
								<span>{control.label}</span>
								<span className="orbit-val">{light[control.key].toFixed(2)}</span>
							</span>
							<input
								type="range"
								min={control.min}
								max={control.max}
								step={control.step}
								value={light[control.key]}
								onChange={(e) => setLight((prev) => ({ ...prev, [control.key]: Number(e.target.value) }))}
							/>
						</label>
					))}
				</section>

				<section className="orbit-group">
					<span className="orbit-eyebrow">Matter</span>
					{MATTER_CONTROLS.map((control) => (
						<label className="orbit-ctl" key={control.key}>
							<span className="orbit-ctl-row">
								<span>{control.label}</span>
								<span className="orbit-val">{matter[control.key].toFixed(2)}</span>
							</span>
							<input
								type="range"
								min={control.min}
								max={control.max}
								step={control.step}
								value={matter[control.key]}
								onChange={(e) => setMatter((prev) => ({ ...prev, [control.key]: Number(e.target.value) }))}
							/>
						</label>
					))}
					{manySchemas && <label className="orbit-ctl">
						<span className="orbit-ctl-row">
							<span>Schema gravity</span>
							<span className="orbit-val">{world.gravity.toFixed(2)}</span>
						</span>
						<input
							type="range" min={0.1} max={4} step={0.05}
							value={world.gravity}
							onChange={(e) => setWorld((prev) => ({ ...prev, gravity: Number(e.target.value) }))}
						/>
					</label>}
					{manySchemas && <label className="orbit-ctl">
						<span className="orbit-ctl-row">
							<span>Cluster spread</span>
							<span className="orbit-val">{world.spread.toFixed(0)}</span>
						</span>
						<input
							type="range" min={140} max={640} step={10}
							value={world.spread}
							onChange={(e) => setWorld((prev) => ({ ...prev, spread: Number(e.target.value) }))}
						/>
					</label>}
				</section>

				<section className="orbit-group">
					<span className="orbit-eyebrow">Pulse</span>
					<button
						type="button"
						className="orbit-toggle"
						aria-pressed={pulseLive}
						disabled={!pulseSupport?.supported}
						onClick={() => { setPulseError(null); setPulseLive((on) => !on); }}
					>
						<i className="orbit-dot" />Live database activity
					</button>
					{pulseLive && (
						<label className="orbit-ctl" style={{ marginTop: 10 }}>
							<span className="orbit-ctl-row">
								<span>Sample every</span>
								<span className="orbit-val">{(pulseInterval / 1000).toFixed(1)}s</span>
							</span>
							<input
								type="range"
								min={MIN_PULSE_INTERVAL_MS}
								max={10000}
								step={250}
								value={pulseInterval}
								onChange={(e) => setPulseInterval(Number(e.target.value))}
							/>
						</label>
					)}
					<p className="orbit-note">
						{pulseError
							? pulseError
							: pulseSupport && !pulseSupport.supported
								? pulseSupport.reason
								: pulseLive && pulseSupport?.source
									? `Reading ${pulseSupport.source} on this database.`
									: "Off: Orbit is showing what this app ran. Turn this on to read what the database itself is doing."}
					</p>

					<span className="orbit-eyebrow orbit-sub">World</span>
					<div className="orbit-toggles">
						<button type="button" className="orbit-toggle" aria-pressed={drift} disabled={reducedMotion} onClick={() => setDrift((on) => !on)}>
							<i className="orbit-dot" />Drift
						</button>
						<button type="button" className="orbit-toggle" aria-pressed={labels} onClick={() => setLabels((on) => !on)}>
							<i className="orbit-dot" />Labels
						</button>
					</div>
					<span className="orbit-eyebrow orbit-sub">Palette</span>
					<div className="orbit-presets">
						{PALETTE_IDS.map((id) => (
							<button type="button" key={id} className="orbit-preset" aria-pressed={paletteId === id} onClick={() => setPaletteId(id)}>
								{PALETTE_LABELS[id]}
							</button>
						))}
					</div>
				</section>

				{counts && (
					<section className="orbit-group orbit-counts">
						<span className="orbit-eyebrow">This database</span>
						<dl>
							<dt>objects</dt><dd>{counts.objects.toLocaleString()}</dd>
							<dt>relations</dt><dd>{counts.relations.toLocaleString()}</dd>
							<dt>foreign keys</dt><dd>{counts.foreignKeys.toLocaleString()}</dd>
							<dt>schemas</dt><dd>{counts.schemas.toLocaleString()}</dd>
							{stats && stats.drawnNodes < stats.nodes && (
								<>
									<dt>drawn</dt><dd>{stats.drawnNodes.toLocaleString()}</dd>
								</>
							)}
						</dl>
						{stats?.lod.note && <p className="orbit-note">{stats.lod.note}</p>}
					</section>
				)}
				</aside>,
			)}

			<div className="orbit-topright">
				{stats && stats.nodes > 0 && (
				<div className="orbit-hud">
					<dl>
						<dt>objects</dt><dd>{stats.drawnNodes.toLocaleString()}</dd>
						<dt>relations</dt><dd>{stats.drawnLinks.toLocaleString()}</dd>
						<dt>in flight</dt><dd className={stats.inFlight > 0 ? 'hot' : undefined}>{stats.inFlight}</dd>
						<dt>draw calls</dt><dd>{stats.drawCalls}</dd>
						<dt>frame</dt><dd>{stats.fps} fps</dd>
					</dl>
				</div>
				)}
			</div>

			{inspector && (
				<div className="orbit-inspector">
					<span className="orbit-kind">{inspector.kind}</span>
					<h2>{inspector.name}</h2>
					<div className="orbit-path">{inspector.path}</div>
					<dl>
						{inspector.rows.map(([label, value]) => (
							<div key={label}><dt>{label}</dt><dd>{value}</dd></div>
						))}
					</dl>
					<p className="orbit-hint">{inspector.hint}</p>
					{inspector.table && onOpenTable && (
						<button type="button" className="orbit-open" onClick={() => onOpenTable(inspector.table!)}>
							<Icon name="table" /> Open this table
						</button>
					)}
				</div>
			)}

			{feed.length > 0 && (
				<div className="orbit-feed">
					<span className="orbit-eyebrow">{pulseLive ? "Pulse / this database" : "Pulse / this session"}</span>
					<ol>
						{feed.slice(0, FEED_ROWS).map((entry) => (
							<li
								key={entry.id}
								className={[entry.live ? 'live' : '', entry.ms !== undefined && entry.ms > SLOW_MS ? 'slow' : ''].filter(Boolean).join(' ') || undefined}
							>
								<span className="orbit-feed-text">{entry.text}</span>
								{entry.ms !== undefined && <span className="orbit-feed-ms">{Math.round(entry.ms)} ms</span>}
							</li>
						))}
					</ol>
				</div>
			)}

			{sceneError && (
				<div className="orbit-empty orbit-no-webgl" role="alert">
					<Icon name="warning" />
					<div>
						<b>Orbit cannot draw here.</b>
						<p>{sceneError}</p>
					</div>
				</div>
			)}

			{!graph && !sceneError && (
				<div className="orbit-empty">
					<Icon name="globe" />
					<div>
						<b>Nothing to map yet.</b>
						<p>Connect to a database and Orbit draws its tables, views, indexes and foreign keys here.</p>
					</div>
				</div>
			)}

			{graph && (
				<div className="orbit-legend">
					drag orbit / scroll zoom / click a star to isolate / esc clear and recentre
				</div>
			)}

		</div>
	);
}
