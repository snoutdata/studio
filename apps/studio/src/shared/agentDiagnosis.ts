/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { agentDescriptor, type AgentKind } from './agentConsole';

/*
 * An agent refused to start.
 *
 * The whole of what this does: notice WHICH part of the agent's own world stopped it, and point at
 * whoever owns that. It does not diagnose, it does not explain the agent's message back to the
 * user, and it does not tell anyone how to fix or update their tool.
 *
 * That boundary was arrived at the hard way, in two goes. First this file offered "Copy the update
 * command" with an `npm install -g` line: wrong because the machine may have no npm, and worse
 * because an agent installed through Homebrew or a native installer would get a SECOND copy
 * shadowing the one they have. Then it explained that their config had been written for a newer
 * build: also overreach, because that is an inference about software we do not own, sitting
 * underneath a message from that software which already says more than we can.
 *
 * The rules, and they are load-bearing:
 *
 *  1. **The agent's message is the explanation.** It is on screen, directly above this strip. We do
 *     not paraphrase it, quote it back, or improve on it.
 *  2. **Point at the owner, never at the fix.** Its settings are its settings; its installation is
 *     its installation. We open the folder or the documentation and stop.
 *  3. **Recognise, or say nothing.** Unrecognised output returns null and the plain "it exited"
 *     line stands. A confident wrong label is worse than no label.
 *  4. **Pure, and tested.** No node, no electron: the panel calls it with the text it already has.
 */

/** Where the user can go. Never a command to run, never something we do to their tool. */
export type AgentFixAction =
	| { kind: 'openConfig'; label: string }
	| { kind: 'openUrl'; label: string; url: string };

export interface AgentDiagnosis {
	/** One line naming what failed. Not why: the agent said why, above. */
	title: string;
	/** One line on whose problem it is, so the pointers make sense. */
	detail: string;
	actions: AgentFixAction[];
}

/** Terminal output is full of escape sequences; match against the text underneath. */
export function stripAnsi(text: string): string {
	return text
		// OSC (title-setting and friends): ESC ] ... BEL, or ESC ] ... ESC \
		.replace(/\][^]*(?:|\\)/g, '')
		// CSI (colour, cursor moves, the bulk of it): ESC [ ... final byte
		.replace(/\[[0-9;?]*[ -/]*[@-~]/g, '')
		// Anything else two-byte, so a stray escape does not survive into a match
		.replace(/[@-Z\\-_]/g, '');
}

/**
 * Which part of the agent's world stopped it, or null when we cannot tell.
 *
 * Only called for a FAILED exit: a clean one is the user quitting, and narrating that back to them
 * is noise. The patterns are matched loosely on purpose — the exact wording belongs to the agent
 * and can change under us, and all a match decides is which pointer to offer.
 */
export function diagnoseStartupFailure(kind: AgentKind, transcript: string): AgentDiagnosis | null {
	const text = stripAnsi(transcript);
	const descriptor = agentDescriptor(kind);
	const label = descriptor.label;
	const docs: AgentFixAction = { kind: 'openUrl', label: `${label} documentation`, url: descriptor.installUrl };
	const settings: AgentFixAction = { kind: 'openConfig', label: `Open ${label}'s settings folder` };

	// Its own configuration stopped it.
	if (/error loading configuration|unknown variant|failed to parse config|invalid config|config(?:uration)? error/i.test(text)) {
		return {
			title: `${label} would not start because of its own settings.`,
			detail: `Its message is above. Those settings live outside SnoutData Studio, so they are yours and ${label}'s to sort out.`,
			actions: [settings, docs],
		};
	}

	// Its launcher is broken: nothing to do with configuration, and equally not ours.
	if (/is not recognized as an internal or external command|cannot find module|MODULE_NOT_FOUND|no such file or directory/i.test(text)) {
		return {
			title: `${label} is on this computer but could not run.`,
			detail: `Its message is above. How ${label} is installed and updated is outside SnoutData Studio.`,
			actions: [docs],
		};
	}

	if (/permission denied|EACCES|EPERM/i.test(text)) {
		return {
			title: `${label} was not allowed to start.`,
			detail: `Its message is above. The system refused it something it needed.`,
			actions: [docs],
		};
	}

	return null;
}
