/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Agent Console contract: the user's own coding agent (Claude Code today, Codex later) run
// as a real process inside the app, one SINGLETON console per agent kind. This file is the
// shared vocabulary — pure, node-free, importable from main, the preload and the renderer
// alike.
//
// The rule the whole feature rests on: the agent is handed CAPABILITIES (over the local MCP
// broker), never CREDENTIALS. Nothing in here carries a secret, and nothing may start to.

/** The coding agents the console knows how to host. Adding one is data, not code. */
export type AgentKind = 'claude' | 'codex' | 'opencode';

/** Everything the console needs to find, launch and describe one agent. */
export interface AgentDescriptor {
	kind: AgentKind;
	/** Shown in the console's tab strip and in Settings. */
	label: string;
	/** Executable to look for on PATH, without a Windows extension (PATHEXT is applied). */
	binary: string;
	/** Arguments that make the binary print its version and exit. */
	probeArgs: string[];
	/** Arguments every launch gets. The MCP handoff flags are appended at spawn time. */
	launchArgs: string[];
	/**
	 * The glyph shown wherever this agent is named: the activity bar, Settings, the console
	 * header. `brand:<id>` is the agent's OWN mark (src/renderer/src/components/BrandMark.tsx),
	 * which is what makes three agents in a row tell themselves apart; a plain Codicon name still
	 * works for anything without a mark.
	 */
	icon: string;
	/**
	 * How our MCP tools reach it.
	 *
	 *  - `flag`: we pass our server on the command line at launch, so the agent has our tools with
	 *    nothing for the user to do, and nothing of theirs is edited. Claude Code takes a generated
	 *    file (`--mcp-config`); Codex takes `-c mcp_servers.…` config overrides, which are the same
	 *    idea in its own spelling (both verified against the installed CLI, see agentMcpConfig.ts).
	 *  - `manual`: the agent only reads MCP servers from its own stored config, which is global to
	 *    every project it opens. Writing that for the user would be editing their tool's settings
	 *    behind their back, so we do not: the console runs the agent, Settings prints the one-time
	 *    command, and the panel says the tools are not wired yet.
	 *
	 * A kind starts as `manual` and moves to `flag` when somebody checks its CLI for a per-session
	 * way in. Codex moved on 2026-08-24, after it was watched in the console hunting a database by
	 * hand (`where mysql`, `set | findstr HOST USER PORT`) because we had handed it nothing.
	 */
	handoff: 'flag' | 'manual';
	/**
	 * Where this agent keeps its own settings, relative to the user's home. We never WRITE there:
	 * which model it uses and how hard it thinks are the user's choices in their own tool. We open
	 * the folder for them when its config is what stopped it starting.
	 */
	configDir: string;
	/** Where the user goes to install it. */
	installUrl: string;
	/** One line the panel shows when the binary is missing. User-facing: no em-dashes. */
	installHint: string;
	/**
	 * The key this agent binds to "read the image on the clipboard yourself", written as the bytes
	 * a terminal sends for it, or `null` if it has none and an image has to reach it as a file path
	 * instead.
	 *
	 * It is per-platform because the agents' own bindings are: Claude Code uses alt+v on Windows
	 * (ESC v) and ctrl+v (0x16) everywhere else. Checked in its own bundle rather than guessed, and
	 * verified end to end against the installed CLI by `e2e/agent-console-live.spec.ts`, which
	 * puts a real image on the clipboard and asserts the agent draws `[Image #1]`.
	 */
	imagePasteKeys: { win32: string; other: string } | null;
}

/** What became of a Ctrl+V that found an image rather than text on the clipboard. */
export type AgentImagePaste =
	/** Nothing to paste: no image on the clipboard, or it could not be read. */
	| { kind: 'none' }
	/** Handed to the agent's own clipboard reader, which is what draws `[Image #1]`. */
	| { kind: 'native' }
	/** Written next to the other pasted images; the path is what goes into the prompt. */
	| { kind: 'file'; path: string };

export const AGENTS: Record<AgentKind, AgentDescriptor> = {
	claude: {
		kind: 'claude',
		label: "Claude Code",
		binary: 'claude',
		probeArgs: ['--version'],
		launchArgs: [],
		icon: 'brand:claude-code',
		handoff: 'flag',
		configDir: '.claude',
		installUrl: 'https://docs.claude.com/en/docs/claude-code',
		installHint: "Claude Code is not installed on this computer. Install it, then reopen this panel.",
		imagePasteKeys: { win32: '\u001bv', other: '\u0016' },
	},
	codex: {
		kind: 'codex',
		label: "Codex",
		binary: 'codex',
		probeArgs: ['--version'],
		launchArgs: [],
		icon: 'brand:openai',
		handoff: 'flag',
		configDir: '.codex',
		installUrl: 'https://developers.openai.com/codex/cli',
		installHint: "Codex is not installed on this computer. Install it, then reopen this panel.",
		// Nothing checked in its CLI, so an image reaches it as a file path. Flip this the day
		// somebody verifies a key in the installed binary, the way Claude Code's was.
		imagePasteKeys: null,
	},
	opencode: {
		kind: 'opencode',
		label: "opencode",
		binary: 'opencode',
		probeArgs: ['--version'],
		launchArgs: [],
		icon: 'brand:opencode',
		handoff: 'manual',
		configDir: '.config/opencode',
		installUrl: 'https://opencode.ai',
		installHint: "opencode is not installed on this computer. Install it, then reopen this panel.",
		imagePasteKeys: null,
	},
};

export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'opencode'];

/**
 * Which console an MCP client's call belongs to, from the name it gave at `initialize`.
 * Clients are not required to send a useful one, so this returns undefined rather than guessing,
 * and the caller falls back to the console that is showing. Order matters: "opencode" contains
 * neither "claude" nor "codex", but a naive "code" check would match all three.
 */
export function agentKindForClient(client: string | undefined): AgentKind | undefined {
	const name = (client ?? '').toLowerCase();
	if (name.includes('opencode')) {
		return 'opencode';
	}
	if (name.includes('codex')) {
		return 'codex';
	}
	if (name.includes('claude')) {
		return 'claude';
	}
	return undefined;
}

export function isAgentKind(value: string): value is AgentKind {
	return value === 'claude' || value === 'codex' || value === 'opencode';
}

/**
 * The bytes to send so THIS agent pastes the image itself, on THIS platform, or null if it cannot.
 */
export function agentImagePasteKey(kind: AgentKind, platform: string): string | null {
	const keys = AGENTS[kind].imagePasteKeys;
	if (!keys) {
		return null;
	}
	return platform === 'win32' ? keys.win32 : keys.other;
}

export function agentDescriptor(kind: AgentKind): AgentDescriptor {
	return AGENTS[kind];
}

/** What discovery found on this machine. Absent `path` ⇒ the binary is not installed. */
export interface AgentInstall {
	installed: boolean;
	/** Absolute path the binary resolved to on PATH. */
	path?: string;
	/**
	 * The user pointed us at this binary themselves, so PATH was not consulted (and, when it is
	 * gone, nothing quietly falls back to a different one: a pin that stops resolving reports as
	 * not installed and says so, rather than running something the user did not choose).
	 */
	pinned?: boolean;
	/** Whatever the probe printed, trimmed to one line. Informational only. */
	version?: string;
	/** When discovery last ran (epoch ms), so the UI can offer a re-check. */
	checkedAt?: number;
}

/** How a session ended. Kept so a closed console can explain itself instead of going blank. */
export interface AgentConsoleExit {
	kind: AgentKind;
	code: number | null;
	signal?: number;
	at: number;
}

/** One console's state, as the renderer sees it. */
export interface AgentConsoleStatus {
	kind: AgentKind;
	label: string;
	running: boolean;
	pid?: number;
	install: AgentInstall;
	lastExit?: AgentConsoleExit;
	/**
	 * There is terminal output to show, whether or not the agent is still running. An agent that
	 * dies on startup prints why and exits; that transcript is kept, and the panel keeps showing it
	 * instead of replacing it with an empty state that says only "exited".
	 */
	hasOutput: boolean;
	/** True when this agent actually has our tools: the broker is up AND its handoff is automatic. */
	mcpWired: boolean;
	/** How its tools are wired (see {@link AgentDescriptor.handoff}), so the panel can explain. */
	handoff: 'flag' | 'manual';
	/**
	 * Whether this agent belongs on the activity bar right now: installed, and not switched off.
	 *
	 * The rule (and the reason this is not just `installed`): a user who has never expressed an
	 * opinion gets the agent shown the FIRST time we find it, including an install that happens
	 * months later. A user who switched it off in Settings does not get it back, however many
	 * times we find it, until they switch it on again. So "no opinion" and "no" are different
	 * states, and only the store can tell them apart.
	 */
	visible: boolean;
	/** True once the user has decided either way. False ⇒ we may still auto-show it on discovery. */
	decided: boolean;
}

/** A chunk of terminal output on its way to the renderer. */
export interface AgentConsoleChunk {
	kind: AgentKind;
	data: string;
	/**
	 * Where this chunk falls in main's output, counted across every console and never reset. An
	 * attach answers with the same count ({@link AgentConsoleAttach.seq}), which is how the panel
	 * tells a chunk its scrollback already holds from one it does not (see {@link ConsoleReplay}).
	 */
	seq: number;
}

/** What attaching to a console returns: its status, what it has said so far, and up to where. */
export interface AgentConsoleAttach {
	status: AgentConsoleStatus;
	scrollback: string;
	/** The {@link AgentConsoleChunk.seq} of the last chunk the scrollback holds. */
	seq: number;
}

/**
 * Joins a console's replayed scrollback with its live output, so nothing is written twice.
 *
 * The panel subscribes to live output and asks main for the scrollback at the same moment, and the
 * answer is asynchronous. Every chunk the agent prints in between arrives TWICE: live, and again
 * inside the scrollback. An agent that starts quickly prints its first lines exactly then, which is
 * how a Linux run showed every opening line doubled (and a test looking for the first line found it
 * scrolled away). So live chunks wait until the scrollback is written, and a chunk the scrollback
 * already covered is dropped.
 */
export class ConsoleReplay {
	private covered: number | null = null;
	private pending: AgentConsoleChunk[] = [];

	constructor(private readonly write: (data: string) => void) {}

	/** A live chunk: held until the scrollback is in, then written unless it is already in it. */
	live(chunk: AgentConsoleChunk): void {
		if (this.covered === null) {
			this.pending.push(chunk);
			return;
		}
		if (chunk.seq > this.covered) {
			this.covered = chunk.seq;
			this.write(chunk.data);
		}
	}

	/** The attach's answer (empty, at 0, when there was none): write it, then what was held. */
	attached(scrollback: string, seq: number): void {
		if (scrollback) {
			this.write(scrollback);
		}
		this.covered = seq;
		const held = this.pending;
		this.pending = [];
		for (const chunk of held) {
			this.live(chunk);
		}
	}
}

/** Scrollback kept in main per session, in bytes. Replayed to the panel on attach. */
export const AGENT_SCROLLBACK_BYTES = 2_000_000;

/** Terminal geometry. The renderer owns it (xterm's FitAddon measures); main just forwards. */
export interface AgentConsoleSize {
	cols: number;
	rows: number;
}

/** Geometry used before the panel has measured anything. */
export const DEFAULT_CONSOLE_SIZE: AgentConsoleSize = { cols: 120, rows: 30 };

/**
 * The console's own (non-secret) settings, persisted by main. Nothing here is a credential.
 * `allowMutatingCapabilities` is the gate on agent actions that CHANGE the app; it is off by
 * default and a corrupt or partial config must leave it off.
 */
export interface AgentConsoleConfig {
	lastKind: AgentKind;
	allowMutatingCapabilities: boolean;
	/**
	 * Whether an agent started here runs under the app's house rules: our MCP server is its only
	 * route to a database, the local database clients are denied, its other MCP servers are left
	 * out of this session, and results are drawn into the app's chat panel instead of printed
	 * into the terminal.
	 *
	 * ON by default, and the only switch here that defaults on: it is not a permission (nothing
	 * here lets the agent do MORE), it is what makes the console part of the app rather than a
	 * terminal that happens to live in our window. Off launches the agent exactly as it comes,
	 * for the user who wants their own setup back.
	 */
	routeDatabaseThroughApp: boolean;
	paths: Partial<Record<AgentKind, string>>;
	/**
	 * What the user has said about each agent. A kind ABSENT here means "never asked, never
	 * decided": the first time we find it installed we turn it on and record that. `enabled: false`
	 * is a decision and is permanent until the user reverses it, so an agent they switched off
	 * stays off no matter how often it is detected. See {@link AgentConsoleStatus.visible}.
	 */
	agents: Partial<Record<AgentKind, AgentPreference>>;
	/**
	 * Capability names the user has said "always allow" to, so the app stops asking for that one
	 * action. Per NAME, never blanket: the master switch above says the agent may ask at all, and
	 * this says which of its questions have already been answered. Empty by default, revocable
	 * one at a time in Settings, Agent access, and irrelevant while the master switch is off.
	 *
	 * This reverses an earlier decision ("deliberately NOT offering always allow"). The
	 * reason it changed: an agent doing real work calls the same handful of actions dozens of
	 * times, and a prompt per call is not a safety feature, it is a feature nobody uses. The same
	 * shape already exists for the assistant's own queries (`tools.autoApproveConnections`).
	 */
	autoApproveCapabilities: string[];
}

export interface AgentPreference {
	/** The user's decision. Absent ⇒ no decision yet. */
	enabled?: boolean;
	/** When we first found it installed (epoch ms), so "first time" is a fact, not a guess. */
	firstSeenAt?: number;
}

/**
 * An external agent is asking to do something that CHANGES the app, and the user has to say yes.
 *
 * The assistant asks for this inside its own chat turn; an agent has no chat turn, so the request
 * arrives on its own and the app answers it on its own. Timing out
 * DECLINES: an unanswered question is not consent.
 */
export interface AgentActionRequest {
	callId: string;
	/** The capability's name, e.g. `open_query_tab`. Shown small, for the user who wants it. */
	name: string;
	/** The same action as a person would say it ("Change a setting"). This is what Settings' list
	 *  of allowed actions calls it, so "Always allow this" and the row it ticks read alike. */
	title: string;
	/** The capability's own one-line description: what it does, in its words. */
	description: string;
	/** Which agent asked, as it named itself on connect (e.g. "claude-code"). */
	client: string;
	/** How long the user has, so the toast can show the clock running down. */
	timeoutMs: number;
	/**
	 * App changes by agents are currently switched OFF, and answering yes here turns them on as
	 * well as allowing this one action. An agent is allowed to ask for that (it is the only way a
	 * user who never opens Settings finds out the app can do any of this), so the card has to say
	 * plainly that the answer is bigger than the action in front of them.
	 */
	turnsOnAppChanges: boolean;
	/**
	 * What this particular call would change, one `field: before → after` line each, when the
	 * action can say (an edit to a saved connection does). The user approves the change itself,
	 * not the action's name.
	 */
	changes?: string[];
	/** A sentence about a consequence of this call the user should read before answering. */
	note?: string;
	/**
	 * Whether "Always allow this" is offered. False for a call whose consequence a standing yes must
	 * never cover: an edit that moves a connection somewhere new asks every time, even when the user
	 * has said "always" to edits before.
	 */
	allowAlways: boolean;
}

/** What the user answered on an {@link AgentActionRequest}. `always` also remembers the capability. */
export type AgentApproval = 'once' | 'always' | 'decline';

/** How long an agent's action request stands before it is declined for the user. */
export const AGENT_ACTION_TIMEOUT_MS = 45_000;
