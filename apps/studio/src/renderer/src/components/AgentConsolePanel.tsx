/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { Icon } from './Icon';
import { Splitter } from './Splitter';
import { AgentCanvas } from './AgentCanvas';
import type { ChatRunOutcome } from './RenderSurface';
import { canvasFor, subscribeCanvas } from '../agentCanvas';
import { DEFAULT_APP_SETTINGS, TERMINAL_FONT_MAX, TERMINAL_FONT_MIN, clampTerminalFontSize } from '../appSettings';
import { ConsoleReplay, agentDescriptor, type AgentConsoleStatus, type AgentKind } from '../../../shared/agentConsole';
import { diagnoseStartupFailure, type AgentDiagnosis, type AgentFixAction } from '../../../shared/agentDiagnosis';
import { AgentAccessArt } from '../art/Illustrations';

/*
 * The Agent Console dock: the user's own coding agent running inside the app.
 *
 * Main owns the session and the scrollback, so this component is disposable: it creates an xterm,
 * replays what main already has, and streams from there. Closing the dock disposes the terminal
 * and NOT the agent, which is why reopening looks like nothing happened.
 *
 * ONE INSTANCE PER AGENT. Since docking each agent's console is its own tool window with its own
 * place in the layout, so the tab strip that used to switch between them is gone: the activity bar
 * is the switcher, and Claude Code can sit on the right while Codex sits at the bottom.
 */

interface AgentConsolePanelProps {
	/** Whether the area this console sits in is collapsed to its header. */
	collapsed: boolean;
	/** The agent this console runs. One console per agent, app-lifetime, owned by main. */
	kind: AgentKind;
	onToggleCollapse(): void;
	onClose(): void;
	/** Open Settings on Agent access (from the "tools need setting up" hint). */
	onOpenSettings(): void;
	/** Changes when the app theme changes, so the terminal's palette is rebuilt from the tokens. */
	themeId: string;
	/** Terminal type size in px (appSettings.terminalFontSize), shared by every console. */
	fontSize: number;
	/** Ask for a new size. The caller clamps and persists; this component never owns the number,
	 *  so the header buttons, the keys, the wheel and Settings all move the same one. */
	onFontSize(size: number): void;
	/*
	 * The agent's own render surface. WHERE it renders follows where the user has put this console
	 * (`agentSurfaceHome` in docking.ts): stacked above the terminal when the console is in a side
	 * dock, and in its own workbench tab when it is in the bottom strip, which has no room to be
	 * two things at once. Everything below is what a drawn SQL card needs to be more than a picture
	 * of SQL: which connection it would act on, and the same insert/run handlers the assistant's
	 * cards use.
	 */
	/** True when this console's surface belongs HERE, above the terminal. False means it is a tab. */
	surfaceInPanel: boolean;
	/** Bring the surface's tab to the front (the header's "shown in a tab" button). */
	onOpenSurface(): void;
	/** Height of the in-panel surface in px, and the drag that changes it. */
	canvasHeight: number;
	onResizeCanvas(dy: number): void;
	/** The connection a drawn card would act on, named on the card. */
	connectionLabel: string;
	/** A document backend proposes native pipelines, so ```json fences become their own cards. */
	isDocument: boolean;
	/** True when something is connected, which is what decides whether Run is offered. */
	hasConnection: boolean;
	onInsertSql(sql: string): void;
	onInsertSqlNewTab(sql: string): void;
	onInsertPipeline(json: string): void;
	onRunSql(sql: string, runId: string): void;
	/** The settled outcome of a Run, echoed back so the card that ran can say what happened. Shared
	 *  with the assistant's cards: run ids are unique, so each surface matches only its own. */
	runOutcome?: ChatRunOutcome | null;
}

/** Read a CSS custom property off the document root, with a fallback for a token a theme omits. */
function token(name: string, fallback: string): string {
	if (typeof window === 'undefined') {
		return fallback;
	}
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return value.length > 0 ? value : fallback;
}

/**
 * The terminal palette, built from the design tokens rather than hardcoded. A literal hex here is
 * a bug in seven themes (the design system is not optional).
 */
function terminalTheme(): ITheme {
	const fg = token('--fg', '#e6e6e6');
	const accent = token('--accent', '#c8a45c');
	return {
		background: token('--bg-widget', '#1a1a1a'),
		foreground: fg,
		cursor: accent,
		cursorAccent: token('--bg-widget', '#1a1a1a'),
		selectionBackground: token('--bg-active', '#333333'),
		black: token('--bg', '#111111'),
		red: token('--error', '#e06c75'),
		green: token('--ok', '#98c379'),
		yellow: token('--warn', '#e5c07b'),
		blue: token('--accent', '#61afef'),
		magenta: token('--accent-hover', '#c678dd'),
		cyan: token('--ok', '#56b6c2'),
		white: fg,
		brightBlack: token('--fg-dim', '#7f7f7f'),
		brightRed: token('--error', '#e06c75'),
		brightGreen: token('--ok', '#98c379'),
		brightYellow: token('--warn', '#e5c07b'),
		brightBlue: token('--accent', '#61afef'),
		brightMagenta: token('--accent-hover', '#c678dd'),
		brightCyan: token('--ok', '#56b6c2'),
		brightWhite: fg,
	};
}

/**
 * What Ctrl/Cmd+V does in a console, and the whole of why it is not just `term.paste`.
 *
 * TEXT WINS when the clipboard has any, because copying out of a spreadsheet or a browser leaves a
 * bitmap on the clipboard beside the text and the user meant the rows. Only when there is no text
 * at all is it an image paste (a screenshot, or Copy image), and then the image goes to the agent
 * the way THAT agent takes one: Claude Code reads the clipboard itself and draws `[Image #1]`, so
 * main sends it its own key; an agent with no such key gets a file, and the path is pasted.
 *
 * `term.paste`, never a raw write, so a multi-line paste arrives inside the bracketed-paste markers
 * as one block instead of a run of Enters.
 */
async function pasteIntoConsole(term: Terminal, kind: AgentKind): Promise<void> {
	let text = '';
	try {
		text = await navigator.clipboard.readText();
	} catch {
		// Clipboard read denied or unavailable: fall through and try the image half.
	}
	if (text) {
		term.paste(text);
		return;
	}
	const image = await window.sqlApi.agentConsole.pasteImage(kind);
	if (image.kind === 'file') {
		// A path with a space in it has to survive the agent's own argument parsing.
		term.paste(image.path.includes(' ') ? `"${image.path}" ` : `${image.path} `);
	}
}

/** Every line the terminal holds, scrollback included, as plain text. */
function terminalTranscript(term: Terminal): string {
	const buffer = term.buffer.active;
	const lines: string[] = [];
	for (let i = 0; i < buffer.length; i++) {
		lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
	}
	return lines.join('\n');
}

/*
 * Introspection hook for the e2e suite, like `__snoutDebugAmbient`: what each MOUNTED console's
 * terminal holds, scrollback included. The rendered rows are only the lines in view, and which
 * lines those are depends on the font's metrics and on when the last refit landed, so "is the
 * transcript still in the terminal" cannot be read off the DOM reliably. Absent for a console whose
 * terminal is not mounted, which is itself something a spec can assert. Local app, no remote
 * content in this renderer.
 */
const debugTranscripts = new Map<AgentKind, () => string>();
(window as unknown as { __snoutDebugAgentTranscript?: (kind: AgentKind) => string | null }).__snoutDebugAgentTranscript =
	(kind) => debugTranscripts.get(kind)?.() ?? null;

export function AgentConsolePanel({
	collapsed, kind, onToggleCollapse, onClose, onOpenSettings, themeId, fontSize, onFontSize,
	surfaceInPanel, onOpenSurface, canvasHeight, onResizeCanvas, connectionLabel, isDocument,
	hasConnection, onInsertSql, onInsertSqlNewTab, onInsertPipeline, onRunSql, runOutcome,
}: AgentConsolePanelProps): JSX.Element {
	const [status, setStatus] = useState<AgentConsoleStatus | null>(null);
	const [busy, setBusy] = useState(false);
	// What the agent said, kept so we can read it after it exits. The terminal has it on screen,
	// but a rendered terminal is not something we can pattern-match.
	const [diagnosis, setDiagnosis] = useState<AgentDiagnosis | null>(null);
	const hostRef = useRef<HTMLDivElement | null>(null);
	const termRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	// The key handler is attached to the terminal once, but the size it changes moves underneath it;
	// a ref keeps the handler current without rebuilding the terminal on every zoom.
	const zoomRef = useRef<(delta: number | 'reset') => void>(() => undefined);
	// How much this agent has drawn. The content is rendered by <AgentCanvas/>, here or in a tab;
	// the count is what decides whether there is a surface to show at all, and what the header's
	// pointer says when the surface is somewhere the user cannot see from here.
	const [shown, setShown] = useState(() => canvasFor(kind).length);

	useEffect(() => {
		const read = (): void => setShown(canvasFor(kind).length);
		read();
		return subscribeCanvas(read);
	}, [kind]);

	const refresh = useCallback(async (target: AgentKind): Promise<AgentConsoleStatus | null> => {
		const next = await window.sqlApi.agentConsole.discover(target);
		setStatus(next);
		return next;
	}, []);

	// Discover on open and whenever the tab changes: the user may have installed the agent while
	// the app was running, and "not installed" is a state they can fix without restarting us.
	useEffect(() => {
		if (collapsed) {
			return;
		}
		void refresh(kind);
	}, [kind, collapsed, refresh]);

	const start = useCallback(async (): Promise<void> => {
		setBusy(true);
		setDiagnosis(null);
		try {
			const cols = termRef.current?.cols;
			const rows = termRef.current?.rows;
			const next = await window.sqlApi.agentConsole.start(kind, cols && rows ? { cols, rows } : undefined);
			setStatus(next);
		} finally {
			setBusy(false);
		}
	}, [kind]);

	const stop = useCallback(async (): Promise<void> => {
		setStatus(await window.sqlApi.agentConsole.stop(kind));
	}, [kind]);

	const restart = useCallback(async (): Promise<void> => {
		setBusy(true);
		try {
			termRef.current?.clear();
			const next = await window.sqlApi.agentConsole.restart(kind);
			setStatus(next);
		} finally {
			setBusy(false);
		}
	}, [kind]);

	// The terminal itself. Torn down and rebuilt when the dock closes or the tab changes; the
	// agent behind it is untouched, and main replays the scrollback on attach.
	// Mounted while the agent is running OR while it has left a transcript behind. The second case
	// is the one that matters: an agent that dies on startup prints why and exits, and swapping that
	// for an empty state told the user "it exited" and threw away the reason.
	const showTerminal = status?.running === true || status?.hasOutput === true;

	useEffect(() => {
		const host = hostRef.current;
		if (collapsed || !host || !showTerminal) {
			return;
		}
		const term = new Terminal({
			theme: terminalTheme(),
			// The size at mount only. Changing it later mutates `term.options` in the effect below
			// rather than re-running this one: rebuilding the terminal to grow the type would throw
			// away the scroll position and flash the screen on every press of Ctrl+plus.
			fontSize: clampTerminalFontSize(fontSize),
			// A concrete stack, not a token: xterm measures a cell by rendering this string itself,
			// and a CSS var() it cannot resolve silently costs the terminal its monospace grid.
			fontFamily: 'ui-monospace, "Cascadia Code", Consolas, "SF Mono", Menlo, monospace',
			cursorBlink: true,
			allowProposedApi: true,
			scrollback: 10000,
		});
		// Paste, and Ctrl/Cmd +, - and 0: the keys every terminal has. Handled here rather than on
		// the window so they only apply while the terminal has focus, and returning false keeps them
		// off the PTY: Ctrl+Minus reaching a shell is a literal control character, not a smaller font.
		term.attachCustomKeyEventHandler((event) => {
			if (event.type !== 'keydown' || !(event.ctrlKey || event.metaKey) || event.altKey) {
				return true;
			}
			// Ctrl/Cmd+V (and Ctrl+Shift+V) pastes, text or image. It has to be caught here: xterm turns
			// Ctrl+V into the literal control character 0x16 and cancels the keydown, which also kills
			// the browser's own paste, so the agent consoles were the one surface in the app where
			// Ctrl+V did nothing at all.
			if (event.key === 'v' || event.key === 'V') {
				// Ours now, both halves: preventDefault stops the browser pasting the same text a second
				// time through xterm's own paste listener, and returning false keeps 0x16 off the PTY.
				event.preventDefault();
				void pasteIntoConsole(term, kind);
				return false;
			}
			if (event.key === '+' || event.key === '=') {
				zoomRef.current(1);
				return false;
			}
			if (event.key === '-' || event.key === '_') {
				zoomRef.current(-1);
				return false;
			}
			if (event.key === '0') {
				zoomRef.current('reset');
				return false;
			}
			return true;
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
		termRef.current = term;
		fitRef.current = fit;
		const transcript = (): string => terminalTranscript(term);
		debugTranscripts.set(kind, transcript);
		let disposed = false;
		// Live output is subscribed before the scrollback is asked for, so nothing printed in
		// between is lost; the replay holds it and drops what the scrollback already carries.
		const replay = new ConsoleReplay((data) => term.write(data));
		const offData = window.sqlApi.agentConsole.onData((chunk) => {
			if (chunk.kind === kind) {
				replay.live(chunk);
			}
		});

		void window.sqlApi.agentConsole.attach(kind).then((attached) => {
			if (disposed) {
				return;
			}
			replay.attached(attached?.scrollback ?? '', attached?.seq ?? 0);
			if (attached) {
				term.focus();
			}
		});
		const typed = term.onData((data) => window.sqlApi.agentConsole.write(kind, data));
		// The renderer measures, main forwards to the PTY: xterm is the only thing that knows how
		// many cells actually fit.
		const resized = term.onResize(({ cols, rows }) => window.sqlApi.agentConsole.resize(kind, { cols, rows }));
		const observer = new ResizeObserver(() => {
			try {
				fit.fit();
			} catch {
				// The dock can be mid-collapse with a zero-height host; the next observation fits it.
			}
		});
		observer.observe(host);
		try {
			fit.fit();
		} catch {
			// As above.
		}

		return () => {
			disposed = true;
			observer.disconnect();
			offData();
			typed.dispose();
			resized.dispose();
			if (debugTranscripts.get(kind) === transcript) {
				debugTranscripts.delete(kind);
			}
			term.dispose();
			termRef.current = null;
			fitRef.current = null;
		};
	}, [kind, collapsed, showTerminal, themeId]);

	// Size changes are applied to the LIVE terminal, then the grid is re-measured: xterm derives its
	// cell size from the font, so a size change is a resize, and without the refit the PTY keeps the
	// old column count and the agent's output wraps in the wrong place.
	useEffect(() => {
		const term = termRef.current;
		if (!term) {
			return;
		}
		term.options.fontSize = clampTerminalFontSize(fontSize);
		fitRef.current?.fit();
	}, [fontSize]);

	const zoom = useCallback((delta: number | 'reset') => {
		onFontSize(delta === 'reset' ? DEFAULT_APP_SETTINGS.terminalFontSize : clampTerminalFontSize(fontSize + delta));
	}, [fontSize, onFontSize]);
	zoomRef.current = zoom;

	// Ctrl/Cmd + wheel over the terminal, the gesture every terminal has. Bound on the host (not the
	// window) and non-passive so the browser's own page zoom does not take it instead.
	useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}
		const onWheel = (event: WheelEvent): void => {
			if (!event.ctrlKey && !event.metaKey) {
				return;
			}
			event.preventDefault();
			if (event.deltaY !== 0) {
				zoom(event.deltaY < 0 ? 1 : -1);
			}
		};
		host.addEventListener('wheel', onWheel, { passive: false });
		return () => host.removeEventListener('wheel', onWheel);
	}, [zoom, showTerminal, collapsed]);

	// A console that exits while the dock is open should say so rather than freeze mid-screen.
	// Re-read the status rather than patching it locally: whether there is a transcript left to show
	// is main's answer (it keeps the scrollback past the session), and it is what decides between
	// "here is what it said before it died" and a bare empty state.
	useEffect(() => {
		return window.sqlApi.agentConsole.onExit((exit) => {
			if (exit.kind !== kind) {
				return;
			}
			setStatus((current) => (current ? { ...current, running: false, pid: undefined, lastExit: exit } : current));
			void window.sqlApi.agentConsole.statuses()
				.then((all) => { setStatus(all.find((s) => s.kind === kind) ?? null); })
				.catch(() => undefined);
			// Only a FAILURE gets diagnosed. A clean exit is the user quitting, and explaining that
			// back to them is noise.
			if (exit.code === 0 || exit.code === null) {
				setDiagnosis(null);
				return;
			}
			void window.sqlApi.agentConsole.attach(kind)
				.then((attached) => { setDiagnosis(attached ? diagnoseStartupFailure(kind, attached.scrollback) : null); })
				.catch(() => setDiagnosis(null));
		});
	}, [kind]);

	// Every action opens something the AGENT owns. Nothing here runs a command or changes a file:
	// see the rules at the top of shared/agentDiagnosis.ts.
	const runFix = useCallback(async (action: AgentFixAction): Promise<void> => {
		if (action.kind === 'openUrl') {
			await window.sqlApi.openExternal(action.url);
			return;
		}
		await window.sqlApi.agentConsole.openConfigFolder(kind);
	}, [kind]);

	const descriptor = agentDescriptor(kind);
	const installed = status?.install.installed === true;

	return (
		<div className="agent-console">
			<div className="pane-header">
				<button
					className="icon-btn"
					aria-label={collapsed ? "Expand agent console" : "Collapse agent console"}
					onClick={onToggleCollapse}
				>
					<Icon name={collapsed ? 'chevron-up' : 'chevron-down'} />
				</button>
				<span className="pane-title">{descriptor.label}</span>
				<span className="spacer" />
				{status?.running && !status.mcpWired && (
					// Two different reasons, and they need different answers from the user: the broker is
					// off (a switch), or this agent only reads MCP servers from its own global config
					// and needs a one-time command (which Settings prints).
					<button
						className="agent-console-warn"
						onClick={onOpenSettings}
						title={status.handoff === 'manual'
							? `${descriptor.label} keeps its own list of tools, so connecting it is a one-time command. Open Settings, Agent access.`
							: "Agent access is off, so this agent has no tools from the app. Open Settings, Agent access."}
					>
						<Icon name="warning" /> {status.handoff === 'manual' ? 'tools need setting up' : 'no app tools'}
					</button>
				)}
				{status?.running && status.mcpWired && (
					<span className="agent-console-ok" title="This agent can query your allowed connections through the app.">
						<Icon name="plug" /> connected
					</span>
				)}
				{showTerminal && (
					// Zoom lives in the header because a terminal's type size is a per-user reading
					// choice, not a preference to go hunting for. Same number as Settings, and the
					// keys and Ctrl+wheel move it too.
					<span className="agent-console-zoom" title={`Terminal text size (${fontSize}px). Ctrl+plus, Ctrl+minus, Ctrl+0, or Ctrl+scroll over the terminal.`}>
						<button className="icon-btn" aria-label="Smaller terminal text" disabled={fontSize <= TERMINAL_FONT_MIN} onClick={() => zoom(-1)}><Icon name="zoom-out" /></button>
						<button className="agent-console-zoom-value" aria-label="Reset terminal text size" onClick={() => zoom('reset')}>{fontSize}</button>
						<button className="icon-btn" aria-label="Bigger terminal text" disabled={fontSize >= TERMINAL_FONT_MAX} onClick={() => zoom(1)}><Icon name="zoom-in" /></button>
					</span>
				)}
				{!surfaceInPanel && shown > 0 && (
					// The surface is a tab from here, so the console has to say where its output went.
					// Without this a push is silent to anyone looking at the terminal, and "it printed
					// nothing" is the bug report we would get.
					<button
						className="agent-console-shown"
						title={`${descriptor.label} has shown you ${shown === 1 ? 'something' : `${shown} things`} in its own tab.`}
						onClick={onOpenSurface}
					>
						<Icon name="preview" /> shown in a tab{shown > 1 ? ` (${shown})` : ''}
					</button>
				)}
				{installed && status?.running && (
					<button className="icon-btn" aria-label="Restart" disabled={busy} onClick={() => void restart()}><Icon name="debug-restart" /></button>
				)}
				{installed && status?.running && (
					<button className="icon-btn" aria-label="Stop" disabled={busy} onClick={() => void stop()}><Icon name="debug-stop" /></button>
				)}
				<button className="icon-btn" aria-label="Close panel" onClick={onClose}><Icon name="close" /></button>
			</div>
			{!collapsed && surfaceInPanel && shown > 0 && (
				// The agent's own thread, above its terminal, the way the assistant's thread sits above
				// its composer. Absent until it draws something: an empty box above every terminal
				// would be a permanent tax on the consoles that never use it. In the bottom strip
				// this is a TAB instead, and the header points at it.
				<>
					<div className="agent-canvas-slot" style={{ flex: `0 0 ${canvasHeight}px` }}>
						<AgentCanvas
							kind={kind}
							placement="panel"
							connectionLabel={connectionLabel}
							isDocument={isDocument}
							hasConnection={hasConnection}
							onInsertSql={onInsertSql}
							onInsertSqlNewTab={onInsertSqlNewTab}
							onInsertPipeline={onInsertPipeline}
							onRunSql={onRunSql}
							runOutcome={runOutcome}
						/>
					</div>
					<Splitter orientation="horizontal" onDrag={(_dx, dy) => onResizeCanvas(dy)} />
				</>
			)}
			{!collapsed && (
				<div className="agent-console-body">
					{!installed && (
						<div className="agent-console-empty">
							<AgentAccessArt className="agent-console-art" />
							<h3>{descriptor.label}</h3>
							<p>{descriptor.installHint}</p>
							<div className="agent-console-actions">
								<button onClick={() => void refresh(kind)}><Icon name="refresh" /> Check again</button>
								<button className="link-btn" onClick={() => window.sqlApi.openExternal(descriptor.installUrl)}>
									Installation guide
								</button>
							</div>
						</div>
					)}
					{installed && !status?.running && !showTerminal && (
						<div className="agent-console-empty">
							<AgentAccessArt className="agent-console-art" />
							<h3>{descriptor.label}</h3>
							<p>
								{status?.lastExit
									? `The agent exited${status.lastExit.code === null ? '' : ` with code ${status.lastExit.code}`}.`
									: "Runs on this computer, in your workspace folder. Your database passwords are never given to it."}
							</p>
							<div className="agent-console-actions">
								<button className="primary" disabled={busy} onClick={() => void start()}><Icon name="play" /> 
									{status?.lastExit ? "Start again" : `Start ${descriptor.label}`}
								</button>
							</div>
							{status?.install.version && <span className="agent-console-version">{status.install.version}</span>}
						</div>
					)}
					<div className="agent-console-term" ref={hostRef} style={installed && showTerminal ? undefined : { display: 'none' }} />
					{installed && !status?.running && showTerminal && (
						<div className={`agent-console-exited${diagnosis ? ' diagnosed' : ''}`}>
							<div className="agent-console-exited-head">
								<Icon name={status?.lastExit?.code ? 'error' : 'debug-stop'} />
								<span>
									{diagnosis
										? diagnosis.title
										: status?.lastExit?.code
											? `${descriptor.label} exited with code ${status.lastExit.code}. Its last output is above.`
											: `${descriptor.label} stopped.`}
								</span>
								<span className="spacer" />
								<button className="primary" disabled={busy} onClick={() => void start()}><Icon name="debug-restart" /> Start again</button>
							</div>
							{diagnosis && (
								<>
									<p className="agent-console-exited-why">{diagnosis.detail}</p>
									<div className="agent-console-exited-actions">
										{diagnosis.actions.map((action) => (
											<button key={action.kind} className="secondary" onClick={() => void runFix(action)}>
												{action.label}
											</button>
										))}
									</div>
								</>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
