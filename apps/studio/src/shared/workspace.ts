/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The workspace is a folder of `.sql` script files the user keeps, browses, and reuses
 * (DBeaver-style). The main-side `WorkspaceStore` owns the root folder + file CRUD + a
 * content search; the renderer's Workspace side view and the AI's workspace capabilities
 * both drive it through these shapes.
 */

/** One `.sql` file in the workspace folder. */
export interface WorkspaceFile {
	/** File name including extension, e.g. "daily-report.sql". */
	name: string;
	/** Absolute path on disk. */
	path: string;
	/** Path relative to the workspace root (flat for now, so usually === name). */
	relPath: string;
	/** Size in bytes. */
	size: number;
	/** Last-modified time, epoch ms. */
	modifiedAt: number;
}

/** A `.sql` script found in a local DBeaver workspace, offered for import. */
export interface DbeaverScript {
	/** Absolute path in the DBeaver workspace. */
	path: string;
	name: string;
	/** The containing folder's name (a rough "project" label for display). */
	folder: string;
	size: number;
	modifiedAt: number;
}

/** Result of scanning for DBeaver scripts: `dataDir` is null when DBeaver isn't installed. */
export interface DbeaverScriptScan {
	dataDir: string | null;
	scripts: DbeaverScript[];
}

/** A file whose name or contents matched a search query, with the matching content lines. */
export interface WorkspaceSearchHit {
	name: string;
	path: string;
	relPath: string;
	/** Whether the file name itself matched the query. */
	nameMatch: boolean;
	/** Matching content lines (1-based line numbers), capped per file. */
	matches: { line: number; text: string }[];
}
