/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Installing a downloaded update while the app sits in the tray.
 *
 * Before this, a downloaded update installed on quit or on "Restart & Update", and the window's
 * close button hides to the tray, so somebody who never quits never installed anything. That is
 * the tail the minimum-version check is about: versions that keep calling a backend long after it moved.
 *
 * The rule is that an install is something nobody should notice. So it happens only while the
 * window is hidden, and only once the app has been doing NOTHING for a while: no flow run, no
 * scheduled flow about to fire, no query (a dashboard poll or an agent's is a query too), no
 * review, no move, no generation or training, no coding agent in a console, no assistant reply
 * streaming. Any of those resets the clock. Pure: main gathers the snapshot, this decides.
 */

/** What the app is doing right now, gathered by main. Every count is "in flight". */
export interface BackgroundActivity {
	/** The window is on screen. A person may be looking at it, so never install. */
	windowVisible: boolean;
	flowRuns: number;
	/** How long until the next scheduled flow is due, or null when none is scheduled. */
	nextScheduledRunInMs: number | null;
	/** Queries executing through the connection manager (interactive or background). */
	queries: number;
	reviewing: boolean;
	moveRuns: number;
	/** Generation workbench batches and training rounds. */
	modelJobs: number;
	/** Coding agents running in a console. Installing would kill their session. */
	agentConsoles: number;
	/** Assistant replies streaming, and agent capability calls in progress. */
	aiStreams: number;
}

/** How long the app must have been idle, window hidden, before an install. */
export const TRAY_INSTALL_QUIET_MS = 5 * 60 * 1000;

/** A scheduled flow due within this is treated as already running: never restart under it. */
export const TRAY_INSTALL_SCHEDULE_MARGIN_MS = 10 * 60 * 1000;

/** What stops an install right now, in words for update.log, or null when nothing does. */
export function trayInstallBlocker(activity: BackgroundActivity): string | null {
	if (activity.windowVisible) {
		return 'the window is open';
	}
	if (activity.flowRuns > 0) {
		return `${activity.flowRuns} flow run(s) in flight`;
	}
	if (activity.nextScheduledRunInMs !== null && activity.nextScheduledRunInMs <= TRAY_INSTALL_SCHEDULE_MARGIN_MS) {
		return 'a scheduled flow is due soon';
	}
	if (activity.queries > 0) {
		return `${activity.queries} query(ies) in flight`;
	}
	if (activity.reviewing) {
		return 'a review is in progress';
	}
	if (activity.moveRuns > 0) {
		return 'a move is running';
	}
	if (activity.modelJobs > 0) {
		return 'a generation or training job is running';
	}
	if (activity.agentConsoles > 0) {
		return 'a coding agent is running';
	}
	if (activity.aiStreams > 0) {
		return 'an assistant or agent call is in progress';
	}
	return null;
}

export interface TrayInstallDecision {
	install: boolean;
	/** When the current quiet stretch began; carry it into the next call. Null while busy. */
	quietSince: number | null;
	blocker: string | null;
}

/**
 * One tick of the decision. `quietSince` is what the previous tick returned. An install needs the
 * app to have been quiet for TRAY_INSTALL_QUIET_MS without a break, so a window hidden a second ago
 * or a poll that just finished does not trigger one.
 */
export function decideTrayInstall(activity: BackgroundActivity, quietSince: number | null, now: number): TrayInstallDecision {
	const blocker = trayInstallBlocker(activity);
	if (blocker) {
		return { install: false, quietSince: null, blocker };
	}
	// A clock that went backwards restarts the stretch rather than counting a negative one as long.
	const since = quietSince === null || quietSince > now ? now : quietSince;
	return { install: now - since >= TRAY_INSTALL_QUIET_MS, quietSince: since, blocker: null };
}
