/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { WorkspaceArt } from '../art/Illustrations';
import type { WorkspaceFile, WorkspaceSearchHit } from '../../../shared/workspace';

interface WorkspaceFilesPanelProps {
	/** Path of the file open in the active editor tab, if any (highlighted in the list). */
	activePath?: string;
	/** Bumped by the app after it saves/creates a workspace file, to force a re-list. */
	rev: number;
	/** Open a workspace file in an editor tab. */
	onOpen(path: string): void;
	/** Open the import-files modal (this computer / DBeaver). */
	onImport(): void;
	onCollapse(): void;
}

function relativeTime(ts: number): string {
	const seconds = Math.round((Date.now() - ts) / 1000);
	if (seconds < 60) {
		return `${seconds}s ago`;
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	return `${Math.round(hours / 24)}d ago`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${Math.round(bytes / 1024)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function folderName(root: string): string {
	const parts = root.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? root;
}

/**
 * Left-side-bar view for the workspace: a folder of `.sql` scripts on disk (DBeaver-style).
 * Browse, create (inline-named), rename, delete, and open files; search filters by name and
 * matches file contents (with line snippets). The AI assistant drives the same store through
 * its workspace capabilities, so anything here is also reachable from chat.
 */
export function WorkspaceFilesPanel(props: WorkspaceFilesPanelProps): JSX.Element {
	const { onOpen } = props;
	const [root, setRoot] = useState<string>('');
	const [files, setFiles] = useState<WorkspaceFile[]>([]);
	const [query, setQuery] = useState('');
	const [hits, setHits] = useState<WorkspaceSearchHit[]>([]);
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState('');
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameName, setRenameName] = useState('');
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const newInputRef = useRef<HTMLInputElement>(null);

	async function refresh(): Promise<void> {
		setRoot(await window.sqlApi.workspace.root());
		setFiles(await window.sqlApi.workspace.list());
	}

	useEffect(() => {
		void refresh();
	}, [props.rev]);

	// Debounced content search; name filtering happens locally for instant feedback.
	useEffect(() => {
		const q = query.trim();
		if (!q) {
			setHits([]);
			return;
		}
		const handle = setTimeout(() => {
			void window.sqlApi.workspace.search(q).then(setHits);
		}, 180);
		return () => clearTimeout(handle);
	}, [query]);

	useEffect(() => {
		if (creating) {
			newInputRef.current?.focus();
		}
	}, [creating]);

	const hitsByPath = useMemo(() => {
		const map = new Map<string, WorkspaceSearchHit>();
		for (const hit of hits) {
			map.set(hit.path, hit);
		}
		return map;
	}, [hits]);

	const q = query.trim().toLowerCase();
	const displayed = q
		? files.filter((f) => f.name.toLowerCase().includes(q) || hitsByPath.has(f.path))
		: files;

	async function commitCreate(): Promise<void> {
		const name = newName.trim();
		setCreating(false);
		setNewName('');
		if (!name) {
			return;
		}
		const file = await window.sqlApi.workspace.create(name);
		await refresh();
		onOpen(file.path);
	}

	async function commitRename(path: string): Promise<void> {
		const name = renameName.trim();
		setRenaming(null);
		if (!name) {
			return;
		}
		await window.sqlApi.workspace.rename(path, name);
		await refresh();
	}

	async function doDelete(path: string): Promise<void> {
		setConfirmDelete(null);
		await window.sqlApi.workspace.remove(path);
		await refresh();
	}

	async function changeFolder(): Promise<void> {
		const next = await window.sqlApi.workspace.setRoot();
		if (next) {
			setQuery('');
			await refresh();
		}
	}

	return (
		<div className="sidebar">
			<div className="sidebar-header">
				<span>WORKSPACE</span>
				<span className="spacer" />
				<button className="icon-btn" aria-label="New file" onClick={() => { setCreating(true); setNewName(''); }}><Icon name="new-file" /></button>
				<button className="icon-btn" aria-label="Import files (this computer or DBeaver)" onClick={props.onImport}><Icon name="cloud-download" /></button>
				<button className="icon-btn" aria-label="Refresh" onClick={() => void refresh()}><Icon name="refresh" /></button>
				<button className="icon-btn" aria-label="Collapse" onClick={props.onCollapse}><Icon name="chevron-left" /></button>
			</div>

			<button className="ws-root" title={`${root}\n(click to change the workspace folder)`} onClick={() => void changeFolder()}>
				<Icon name="folder" />
				<span className="ws-root-name">{root ? folderName(root) : "…"}</span>
			</button>

			<div className="ws-search">
				<Icon name="search" />
				<input
					type="text"
					placeholder="Search files and contents"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				{query && <button className="icon-btn" aria-label="Clear" onClick={() => setQuery('')}><Icon name="close" /></button>}
			</div>

			<div className="queries-list">
				{creating && (
					<div className="ws-newfile">
						<Icon name="file" />
						<input
							ref={newInputRef}
							className="ws-name-input"
							placeholder="file-name.sql"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') { void commitCreate(); }
								else if (e.key === 'Escape') { setCreating(false); setNewName(''); }
							}}
							onBlur={() => void commitCreate()}
						/>
					</div>
				)}

				{!creating && displayed.length === 0 && (
					<div className="ws-empty">
						{q ? <Icon name="search" /> : <WorkspaceArt className="ws-empty-art" />}
						<p>{q ? "No matching files." : "No SQL files in this workspace yet."}</p>
						{!q && <button className="ws-empty-cta" onClick={() => { setCreating(true); setNewName(''); }}><Icon name="new-file" /> New file</button>}
					</div>
				)}

				{displayed.map((file) => {
					const hit = hitsByPath.get(file.path);
					const contentMatches = hit?.matches ?? [];
					const isActive = props.activePath === file.path;
					return (
						<div key={file.path} className={`query-row ws-file${isActive ? ' active' : ''}`}>
							{renaming === file.path ? (
								<input
									className="ws-name-input"
									autoFocus
									value={renameName}
									onChange={(e) => setRenameName(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === 'Enter') { void commitRename(file.path); }
										else if (e.key === 'Escape') { setRenaming(null); }
									}}
									onBlur={() => void commitRename(file.path)}
								/>
							) : (
								<div className="ws-file-main" onClick={() => onOpen(file.path)}>
									<Icon name="file" />
									<span className="ws-file-name">{file.name}</span>
									{contentMatches.length > 0 && <span className="ws-badge" title="Matches in file contents">{contentMatches.length}</span>}
									<span className="spacer" />
									<span className="ws-file-actions">
										<button className="icon-btn" aria-label="Rename" onClick={(e) => { e.stopPropagation(); setRenaming(file.path); setRenameName(file.name); }}><Icon name="edit" /></button>
										<button className="icon-btn" aria-label="Delete" onClick={(e) => { e.stopPropagation(); setConfirmDelete(file.path); }}><Icon name="trash" /></button>
									</span>
								</div>
							)}

							<div className="ws-meta" onClick={() => onOpen(file.path)}>
								<span className="muted">{relativeTime(file.modifiedAt)}</span>
								<span className="muted">{formatSize(file.size)}</span>
							</div>

							{contentMatches.map((m) => (
								<div key={m.line} className="ws-snippet" onClick={() => onOpen(file.path)}>
									<span className="ws-snippet-line">{m.line}</span>
									<span className="ws-snippet-text">{m.text}</span>
								</div>
							))}

							{confirmDelete === file.path && (
								<div className="ws-confirm">
									<span>Delete {file.name}?</span>
									<span className="spacer" />
									<button className="ws-confirm-no" onClick={() => setConfirmDelete(null)}><Icon name="close" /> Cancel</button>
									<button className="ws-confirm-yes" onClick={() => void doDelete(file.path)}><Icon name="trash" /> Delete</button>
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
