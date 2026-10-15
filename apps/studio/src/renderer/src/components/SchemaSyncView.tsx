/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_NAME } from '../../../shared/assistant';
import { useEffect, useMemo, useRef, useState } from 'react';
import { monaco } from '../monaco';
import { Icon } from './Icon';
import { Splitter } from './Splitter';
import { useConfirm } from './ConfirmDialog';
import type { ConnectionConfig } from '../../../shared/connection';
import { type ApplyStatement, type ChangeClass, type MigrationPlan, type MigrationStatement } from '../../../shared/engine';

interface SchemaSyncViewProps {
	connections: ConnectionConfig[];
	connectedIds: string[];
	/** Called after a successful (or partial) apply so the caller can refresh the target schema. */
	onApplied(targetId: string): void;
	/** Hand the failing statement to the AI chat panel: opens the chat grounded in the target and
	 *  streams a diagnosis + corrected DDL the user pastes back into the editor below to retry. */
	onFixWithAI(params: { sql: string; error: string; connectionId: string; objectName: string }): void;
	onClose(): void;
}

type Phase = 'pick' | 'preview' | 'applying' | 'failed' | 'done';

interface FailureState {
	index: number;
	resumeFrom: number;
	error: string;
	rolledBack: boolean;
}

const CLASS_LABEL: Record<ChangeClass, string> = { add: 'Add', alter: 'Modify', drop: 'Delete' };
const CLASS_ORDER: ChangeClass[] = ['add', 'alter', 'drop'];
// Object types whose creation depends on the target's existing data, not just its schema: a unique
// index or primary key fails on duplicate rows, a foreign key on orphaned rows. Cleaning that data
// is the user's job, not schema sync's, so they can hide this whole group in one toggle.
const KEY_TYPES = new Set<string>(['primaryKey', 'index', 'foreignKey']);
const OBJECT_ICON: Record<string, string> = {
	table: 'table', column: 'symbol-field', primaryKey: 'key', index: 'list-flat',
	foreignKey: 'references', trigger: 'zap', routine: 'symbol-method', view: 'eye',
};

/** A read-only-or-editable Monaco SQL pane that mirrors the main editor's look (the "feels like
 *  the SQL editor" surface). External value changes are pushed in; user edits flow back out. */
function MonacoSql(props: { value: string; readOnly: boolean; onChange?(value: string): void; revealLine?: number }): JSX.Element {
	const hostRef = useRef<HTMLDivElement>(null);
	const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
	const onChangeRef = useRef(props.onChange);
	onChangeRef.current = props.onChange;

	useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}
		const editor = monaco.editor.create(host, {
			value: props.value,
			language: 'sql',
			readOnly: props.readOnly,
			automaticLayout: true,
			glyphMargin: false,
			lineNumbersMinChars: 3,
			minimap: { enabled: false },
			fontSize: 13,
			wordWrap: 'on',
			scrollBeyondLastLine: false,
			renderLineHighlight: props.readOnly ? 'none' : 'line',
		});
		editorRef.current = editor;
		const sub = editor.onDidChangeModelContent(() => onChangeRef.current?.(editor.getValue()));
		return () => { sub.dispose(); editor.dispose(); };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		const editor = editorRef.current;
		if (editor && editor.getValue() !== props.value) {
			editor.setValue(props.value);
		}
	}, [props.value]);

	useEffect(() => {
		const editor = editorRef.current;
		if (editor && props.revealLine != null) {
			editor.revealLineNearTop(props.revealLine);
		}
	}, [props.revealLine]);

	return <div className="schema-sync-monaco" ref={hostRef} />;
}

/**
 * Full-area schema sync workspace: pick a SOURCE (desired state) and TARGET (the database that
 * gets changed), then review the deterministic migration in a two-pane layout — the change list
 * (with sync-mode controls) on the left, the generated SQL in a real editor on the right. The AI
 * is offered only when a statement fails to apply, to propose a fix the user can accept and resume.
 */
export function SchemaSyncView(props: SchemaSyncViewProps): JSX.Element {
	const connected = useMemo(
		() => props.connections.filter((c) => props.connectedIds.includes(c.id)),
		[props.connections, props.connectedIds],
	);

	const [sourceId, setSourceId] = useState('');
	const [targetId, setTargetId] = useState('');
	const [phase, setPhase] = useState<Phase>('pick');
	const [plan, setPlan] = useState<MigrationPlan | null>(null);
	const [included, setIncluded] = useState<Set<string>>(new Set());
	// Change classes the user has collapsed out of the list (Add/Modify/Delete filters). A hidden
	// class is also excluded from the migration, so the SQL pane always matches what's on screen.
	const [hidden, setHidden] = useState<Set<ChangeClass>>(new Set());
	// When true, key/index/FK changes are hidden and excluded (they fail on dirty target data).
	const [hideKeys, setHideKeys] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	// Free-text filter over the change list (display only; never changes what's included/applied).
	const [query, setQuery] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [listWidth, setListWidth] = useState(420);
	// How many statements the last Apply pushed, surfaced as a banner after the auto re-diff so
	// the user can keep applying a few tables at a time.
	const [lastApplied, setLastApplied] = useState(0);
	// Anchor row id for shift-click range selection.
	const anchorRef = useRef<string | null>(null);
	// Statement ids that succeeded during the current Apply (accumulates across a retry/resume run),
	// so when it finishes we drop exactly those from the list and keep the rest of the view intact.
	const appliedIdsRef = useRef<Set<string>>(new Set());

	const [appliedSoFar, setAppliedSoFar] = useState(0);
	const [failure, setFailure] = useState<FailureState | null>(null);
	const [overrides, setOverrides] = useState<Record<string, string>>({});
	const [editSql, setEditSql] = useState('');
	// True once the failing statement has been handed to the AI chat panel, so the pane can point
	// the user there (the fix streams in the chat; they paste the corrected DDL back into editSql).
	const [askedAi, setAskedAi] = useState(false);

	const [confirm, confirmDialog] = useConfirm();

	const sourceConfig = connected.find((c) => c.id === sourceId);
	const targetOptions = connected.filter((c) => c.id !== sourceId && (!sourceConfig || c.driver === sourceConfig.driver));
	const targetConfig = connected.find((c) => c.id === targetId);

	// Rows not collapsed by a class filter (or the keys/indexes toggle).
	const visible = useMemo<MigrationStatement[]>(
		() => (plan ? plan.statements.filter((s) => !hidden.has(s.changeClass) && !(hideKeys && KEY_TYPES.has(s.objectType))) : []),
		[plan, hidden, hideKeys],
	);
	// Rows actually rendered: `visible` narrowed by the search box. The order matches the plan, so
	// shift-click ranges and select-all act on exactly what the user sees.
	const shown = useMemo<MigrationStatement[]>(() => {
		const q = query.trim().toLowerCase();
		if (!q) {
			return visible;
		}
		return visible.filter((s) => s.description.toLowerCase().includes(q) || s.objectName.toLowerCase().includes(q));
	}, [visible, query]);
	// What will actually be applied: included AND not in a hidden (collapsed) class or the keys group.
	const selected = useMemo<MigrationStatement[]>(
		() => (plan ? plan.statements.filter((s) => included.has(s.id) && !hidden.has(s.changeClass) && !(hideKeys && KEY_TYPES.has(s.objectType))) : []),
		[plan, included, hidden, hideKeys],
	);
	const destructiveCount = selected.filter((s) => s.destructive).length;

	function sqlOf(statement: MigrationStatement): string {
		return overrides[statement.id] ?? statement.sql;
	}

	// The full migration script (selected statements) + the start line of each, so clicking a row
	// reveals its statement in the SQL pane.
	const { script, lineOf } = useMemo(() => {
		const parts: string[] = [];
		const map = new Map<string, number>();
		let line = 1;
		for (const s of selected) {
			map.set(s.id, line);
			const text = sqlOf(s).trimEnd();
			const withSemi = text.endsWith(';') ? text : `${text};`;
			parts.push(withSemi);
			line += withSemi.split('\n').length + 1;
		}
		return { script: parts.join('\n\n'), lineOf: map };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selected, overrides]);

	async function computeDiff(): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const result = await window.sqlApi.schemaDiff(sourceId, targetId);
			if (!result.ok) {
				setError(result.error);
				return;
			}
			setPlan(result.plan);
			setIncluded(new Set(result.plan.statements.map((s) => s.id)));
			setHidden(new Set());
			setHideKeys(false);
			setQuery('');
			setLastApplied(0);
			appliedIdsRef.current = new Set();
			setSelectedId(result.plan.statements[0]?.id ?? null);
			setPhase('preview');
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	// Re-introspect the target (its schema is cached in the server) and rebuild the plan from the
	// live state. Used after the user fixes the cause of a failure (e.g. clears duplicate rows the
	// AI flagged) so the remaining diff reflects reality. Returns to the preview list.
	async function recompute(): Promise<void> {
		setBusy(true);
		try {
			await window.sqlApi.refresh(targetId);
		} catch {
			// A refresh failure surfaces in the diff below; don't block the recompute.
		}
		await computeDiff();
	}

	function toggle(id: string): void {
		setIncluded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}

	// Collapse / reveal a whole change class (Add/Modify/Delete). A collapsed class is hidden from
	// the list and dropped from the migration; revealing it restores it.
	function toggleClassHidden(cls: ChangeClass): void {
		setHidden((prev) => {
			const next = new Set(prev);
			if (next.has(cls)) {
				next.delete(cls);
			} else {
				next.add(cls);
			}
			return next;
		});
	}

	// Check / uncheck every currently-shown row at once (respects the search filter).
	function setAllShown(on: boolean): void {
		setIncluded((prev) => {
			const next = new Set(prev);
			for (const s of shown) {
				if (on) {
					next.add(s.id);
				} else {
					next.delete(s.id);
				}
			}
			return next;
		});
	}

	// Row checkbox click: plain click toggles one; shift-click sets the whole range between the
	// last-clicked anchor and this row to this row's new state (standard list multi-select).
	function clickRow(id: string, shift: boolean): void {
		if (shift && anchorRef.current && anchorRef.current !== id) {
			const ids = shown.map((s) => s.id);
			const a = ids.indexOf(anchorRef.current);
			const b = ids.indexOf(id);
			if (a >= 0 && b >= 0) {
				const [lo, hi] = a < b ? [a, b] : [b, a];
				const on = !included.has(id);
				setIncluded((prev) => {
					const next = new Set(prev);
					for (const rid of ids.slice(lo, hi + 1)) {
						if (on) {
							next.add(rid);
						} else {
							next.delete(rid);
						}
					}
					return next;
				});
				anchorRef.current = id;
				return;
			}
		}
		toggle(id);
		anchorRef.current = id;
	}

	async function applyFrom(startIndex: number, effectiveOverrides: Record<string, string> = overrides): Promise<void> {
		setPhase('applying');
		setError(null);
		const sqlFor = (s: MigrationStatement): string => effectiveOverrides[s.id] ?? s.sql;
		const batch: ApplyStatement[] = selected.slice(startIndex).map((s) => ({ id: s.id, sql: sqlFor(s) }));
		try {
			const result = await window.sqlApi.applyMigration(targetId, batch);
			if (result.ok) {
				for (const s of selected.slice(startIndex)) {
					appliedIdsRef.current.add(s.id);
				}
				setAppliedSoFar(startIndex + batch.length);
				setFailure(null);
				removeApplied();
				return;
			}
			if (result.failedIndex < 0) {
				setError(result.error);
				setPhase('failed');
				return;
			}
			const failedAbs = startIndex + result.failedIndex;
			// Auto-commit drivers (mysql/sqlserver) actually ran the statements before the failure;
			// remember them so the eventual finish removes them too. A rolled-back PG batch applied none.
			if (!result.rolledBack) {
				for (const s of selected.slice(startIndex, failedAbs)) {
					appliedIdsRef.current.add(s.id);
				}
			}
			const resumeFrom = result.rolledBack ? startIndex : failedAbs;
			setAppliedSoFar(result.rolledBack ? startIndex : failedAbs);
			setFailure({ index: failedAbs, resumeFrom, error: result.error, rolledBack: result.rolledBack });
			setSelectedId(selected[failedAbs]?.id ?? null);
			setEditSql(sqlFor(selected[failedAbs]));
			setAskedAi(false);
			setPhase('failed');
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase('failed');
		}
	}

	// A successful Apply finished: drop exactly the statements that ran from the list and keep
	// everything else (the search filter, hidden classes, and remaining selection) as-is, so the
	// user can keep working through the same view a few tables at a time. The target schema is
	// re-introspected (via onApplied) for completion/hover, but the migration list is not rebuilt.
	function removeApplied(): void {
		props.onApplied(targetId);
		const applied = appliedIdsRef.current;
		appliedIdsRef.current = new Set();
		const remaining = plan ? plan.statements.filter((s) => !applied.has(s.id)) : [];
		setLastApplied(applied.size);
		setPlan(plan ? { ...plan, statements: remaining } : null);
		setIncluded((prev) => {
			const next = new Set(prev);
			for (const id of applied) {
				next.delete(id);
			}
			return next;
		});
		setOverrides((prev) => {
			const next = { ...prev };
			for (const id of applied) {
				delete next[id];
			}
			return next;
		});
		setFailure(null);
		if (selectedId && applied.has(selectedId)) {
			setSelectedId(remaining[0]?.id ?? null);
		}
		setPhase(remaining.length === 0 ? 'done' : 'preview');
	}

	async function confirmAndApply(): Promise<void> {
		const danger = destructiveCount > 0 || targetConfig?.environment === 'prod';
		const ok = await confirm({
			title: `Apply ${selected.length} statement${selected.length === 1 ? '' : 's'} to ${targetConfig?.label ?? 'target'}?`,
			danger,
			confirmLabel: 'Apply',
			body: (
				<>
					This changes <strong>{targetConfig?.label}{targetConfig?.database ? ` / ${targetConfig.database}` : ''}</strong>
					{destructiveCount > 0 && <>, including <span className="schema-sync-destructive">{destructiveCount} destructive change{destructiveCount === 1 ? '' : 's'}</span> that can lose data</>}.
					{plan?.transactional ? ' It runs in a single transaction (all-or-nothing).' : ' Statements apply one by one; a failure can be fixed and resumed.'}
				</>
			),
		});
		if (ok) {
			void applyFrom(0);
		}
	}

	function askAi(): void {
		if (!failure) {
			return;
		}
		const statement = selected[failure.index];
		props.onFixWithAI({
			sql: editSql,
			error: failure.error,
			connectionId: targetId,
			objectName: statement.objectName,
		});
		setAskedAi(true);
	}

	function retry(): void {
		if (!failure) {
			return;
		}
		const statement = selected[failure.index];
		const next = { ...overrides, [statement.id]: editSql };
		setOverrides(next);
		void applyFrom(failure.resumeFrom, next);
	}

	function skip(): void {
		if (failure) {
			void applyFrom(failure.index + 1);
		}
	}

	function backToPicker(): void {
		setPhase('pick');
		setPlan(null);
		setIncluded(new Set());
		setHidden(new Set());
		setHideKeys(false);
		setQuery('');
		setSelectedId(null);
		setError(null);
		setFailure(null);
		setOverrides({});
		setAppliedSoFar(0);
		setLastApplied(0);
		appliedIdsRef.current = new Set();
	}

	const dropStatements = plan?.statements.filter((s) => s.changeClass === 'drop') ?? [];
	const additiveOnly = dropStatements.length > 0 && !selected.some((s) => s.changeClass === 'drop');
	// Count of key/index/FK changes in the plan. The toggle shows for every dialect (all three carry
	// these object types); when the current diff has none it is greyed out rather than hidden.
	const keyCount = plan?.statements.filter((s) => KEY_TYPES.has(s.objectType)).length ?? 0;
	// Whether every shown row is currently checked (drives the select-all / unselect-all toggle).
	const allShownOn = shown.length > 0 && shown.every((s) => included.has(s.id));

	return (
		<div className="schema-sync-view">
			<header className="schema-sync-head">
				<span className="schema-sync-title"><Icon name="git-compare" /> Schema Sync</span>
				{(phase === 'preview' || phase === 'failed') && targetConfig && (
					<span className="schema-sync-route">
						<span className="schema-sync-conn">{sourceConfig?.label}</span>
						<Icon name="arrow-right" />
						<span className={`schema-sync-conn${targetConfig.environment === 'prod' ? ' prod' : ''}`}>
							{targetConfig.label}{targetConfig.environment === 'prod' ? ' · PROD' : ''}
						</span>
					</span>
				)}
				<span className="spacer" />
			</header>

			{phase === 'pick' && (
				<div className="schema-sync-pick">
					<div className="schema-sync-pick-card">
						<h2>Sync a database schema</h2>
						<p className="confirm-detail">
							The <strong>source</strong> defines the desired schema; the <strong>target</strong> is changed to match it.
							Both must be connected and use the same database type.
						</p>
						{connected.length < 2 ? (
							<p className="status danger">Connect at least two databases of the same type to sync.</p>
						) : (
							<div className="schema-sync-pick-row">
								<label>
									Source (desired state)
									<select value={sourceId} onChange={(e) => { setSourceId(e.target.value); setTargetId(''); }}>
										<option value="">Select a connection…</option>
										{connected.map((c) => (
											<option key={c.id} value={c.id}>{c.label}{c.database ? ` / ${c.database}` : ''}</option>
										))}
									</select>
								</label>
								<Icon name="arrow-right" className="schema-sync-pick-arrow" />
								<label>
									Target (gets changed)
									<select value={targetId} onChange={(e) => setTargetId(e.target.value)} disabled={!sourceId}>
										<option value="">Select a connection…</option>
										{targetOptions.map((c) => (
											// A read-only connection may be the source but never the target, so it is listed and
											// cannot be picked (main refuses to apply to one as well).
											<option key={c.id} value={c.id} disabled={c.readOnly}>
												{c.label}{c.database ? ` / ${c.database}` : ''}{c.environment === 'prod' ? ' (PROD)' : ''}{c.readOnly ? ' (read-only, cannot be changed)' : ''}
											</option>
										))}
									</select>
								</label>
							</div>
						)}
						{error && <p className="status danger">{error}</p>}
						<div className="schema-sync-pick-actions">
							<button type="button" onClick={() => void computeDiff()} disabled={!sourceId || !targetId || busy}><Icon name="diff" /> 
								{busy ? 'Comparing…' : 'Compare schemas'}
							</button>
						</div>
					</div>
				</div>
			)}

			{phase === 'preview' && plan && (
				plan.statements.length === 0 ? (
					<div className="schema-sync-empty">
						<Icon name="check-all" className="schema-sync-empty-icon" />
						<h2>In sync</h2>
						<p className="confirm-detail">The target already matches the source. No changes needed.</p>
						<div className="schema-sync-pick-actions">
							<button type="button" className="secondary" onClick={backToPicker}><Icon name="arrow-left" /> Choose different databases</button>
							<button type="button" onClick={props.onClose}><Icon name="close" /> Close</button>
						</div>
					</div>
				) : (
					<>
						<div className="schema-sync-modes">
							{CLASS_ORDER.map((cls) => {
								const items = plan.statements.filter((s) => s.changeClass === cls);
								if (items.length === 0) {
									return null;
								}
								const shown = !hidden.has(cls);
								return (
									<button
										key={cls}
										type="button"
										className={`schema-sync-chip t-${cls}${shown ? ' on' : ''}`}
										onClick={() => toggleClassHidden(cls)}
										title={cls === 'drop'
											? 'Deletes objects that exist only on the target. Hide it to sync additively, never removing anything.'
											: `Show or hide ${CLASS_LABEL[cls]} changes`}
									>
										<Icon name={shown ? 'eye' : 'eye-closed'} /> {CLASS_LABEL[cls]} {items.length}
									</button>
								);
							})}
							<button
								type="button"
								className={`schema-sync-chip${!hideKeys ? ' on' : ''}`}
								onClick={() => setHideKeys((v) => !v)}
								disabled={keyCount === 0}
								title={keyCount === 0
									? 'No key, index or foreign-key changes in this diff.'
									: 'Keys, indexes and foreign keys can fail to apply when the target has duplicate or orphaned rows (a data issue, not a schema one). Hide them to sync the rest, then add them once the data is clean.'}
							>
								<Icon name={!hideKeys ? 'eye' : 'eye-closed'} /> Keys &amp; indexes {keyCount}
							</button>
							<span className="spacer" />
							<span className="schema-sync-selcount">{selected.length} selected</span>
							<button type="button" className="schema-sync-selall" onClick={() => setAllShown(!allShownOn)} disabled={shown.length === 0}>
								{allShownOn ? 'Unselect all' : 'Select all'}
							</button>
						</div>
						<div className="schema-sync-split">
							<div className="schema-sync-left" style={{ flexBasis: listWidth }}>
								<div className="schema-sync-search">
									<Icon name="search" />
									<input
										type="text"
										value={query}
										placeholder="Filter changes…"
										onChange={(e) => setQuery(e.target.value)}
									/>
									{query && <button type="button" className="icon-btn" aria-label="Clear filter" onClick={() => setQuery('')}><Icon name="close" /></button>}
								</div>
								{lastApplied > 0 && (
									<p className="schema-sync-hint applied">
										<Icon name="check" /> Applied {lastApplied} statement{lastApplied === 1 ? '' : 's'}. {plan.statements.length} change{plan.statements.length === 1 ? '' : 's'} still differ.
									</p>
								)}
								{additiveOnly && <p className="schema-sync-hint"><Icon name="shield" /> Additive sync: nothing will be removed from the target.</p>}
								<div className="schema-sync-rows">
									{shown.length === 0 && <p className="schema-sync-nomatch">No changes match "{query}".</p>}
									{shown.map((s) => {
										const on = included.has(s.id);
										return (
											<div
												key={s.id}
												className={`schema-sync-card t-${s.changeClass}${on ? '' : ' off'}${selectedId === s.id ? ' active' : ''}`}
												title="Click to include or exclude, shift-click to select a range"
												onClick={(e) => { setSelectedId(s.id); clickRow(s.id, e.shiftKey); }}
											>
												<input type="checkbox" checked={on} readOnly tabIndex={-1} className="schema-sync-check" />
												<span className={`schema-sync-tag t-${s.changeClass}`}>{CLASS_LABEL[s.changeClass]}</span>
												<Icon name={OBJECT_ICON[s.objectType] ?? 'symbol-misc'} className="schema-sync-objicon" />
												<span className="schema-sync-desc">{s.description.replace(/`/g, '')}</span>
												{s.destructive && <span title="Can lose data"><Icon name="warning" className="schema-sync-warn" /></span>}
											</div>
										);
									})}
								</div>
							</div>
							<Splitter orientation="vertical" onDrag={(dx) => setListWidth((w) => Math.min(720, Math.max(280, w + dx)))} />
							<div className="schema-sync-right">
								<div className="schema-sync-sqlhead">
									<Icon name="file-code" /> Migration SQL
									<span className="schema-sync-sqlcount">{selected.length} statement{selected.length === 1 ? '' : 's'}</span>
									<span className="spacer" />
									<button className="icon-btn" type="button" aria-label="Copy full script" onClick={() => void navigator.clipboard.writeText(script)}><Icon name="copy" /></button>
								</div>
								<MonacoSql value={script} readOnly revealLine={selectedId ? lineOf.get(selectedId) : undefined} />
							</div>
						</div>
						<footer className="schema-sync-foot">
							<button type="button" className="secondary" onClick={backToPicker}><Icon name="arrow-left" /> Back</button>
							<span className="schema-sync-summary">
								{selected.length} of {plan.statements.length} selected
								{destructiveCount > 0 && <> · <span className="schema-sync-destructive">{destructiveCount} destructive</span></>}
							</span>
							<span className="spacer" />
							<button type="button" className="secondary" onClick={props.onClose}><Icon name="close" /> Close</button>
							<button
								type="button"
								className={destructiveCount > 0 || targetConfig?.environment === 'prod' ? 'danger' : ''}
								onClick={() => void confirmAndApply()}
								disabled={selected.length === 0}
							><Icon name="check" /> 
								Apply{targetConfig?.environment === 'prod' ? ' to PRODUCTION' : ''}
							</button>
						</footer>
					</>
				)
			)}

			{phase === 'applying' && (
				<div className="schema-sync-empty">
					<Icon name="loading" className="codicon-modifier-spin schema-sync-empty-icon" />
					<h2>Applying migration…</h2>
					<p className="confirm-detail">Running against {targetConfig?.label}.</p>
				</div>
			)}

			{phase === 'failed' && (
				<>
					<div className="schema-sync-errorbar">
						<Icon name="error" />
						<span className="schema-sync-errortitle">
							{failure ? `Statement ${failure.index + 1} of ${selected.length} failed` : 'Migration stopped'}{failure?.rolledBack ? ' · transaction rolled back' : ''}
						</span>
					</div>
					{(failure?.error || error) && <p className="status danger schema-sync-dberror">{failure?.error ?? error}</p>}
					<div className="schema-sync-split">
						<div className="schema-sync-left" style={{ flexBasis: listWidth }}>
							<div className="schema-sync-rows">
								{selected.map((s, i) => (
									<div
										key={s.id}
										className={`schema-sync-card t-${s.changeClass}${failure && i === failure.index ? ' failed' : i < (failure?.index ?? appliedSoFar) ? ' done' : ''}`}
									>
										<Icon name={failure && i === failure.index ? 'error' : i < (failure?.index ?? appliedSoFar) ? 'pass' : 'circle-outline'} className="schema-sync-objicon" />
										<span className="schema-sync-desc">{s.description.replace(/`/g, '')}</span>
									</div>
								))}
							</div>
						</div>
						<Splitter orientation="vertical" onDrag={(dx) => setListWidth((w) => Math.min(720, Math.max(280, w + dx)))} />
						<div className="schema-sync-right">
							{failure ? (
								<>
									<div className="schema-sync-sqlhead">
										<Icon name="file-code" /> Corrected statement
										<span className="schema-sync-sqlcount">edit, then Retry</span>
									</div>
									<MonacoSql value={editSql} readOnly={false} onChange={setEditSql} />
									{askedAi && (
										<p className="schema-sync-hint applied">
											<Icon name="comment-discussion" /> Sent to {ASSISTANT_NAME}. Read its fix in the chat, paste the corrected statement above, then Retry.
										</p>
									)}
								</>
							) : (
								<div className="schema-sync-empty">
									<Icon name="warning" className="schema-sync-empty-icon" />
									<p className="confirm-detail">The migration stopped before a single statement could be pinpointed. Go back to the changes, or recompute the diff against the live database.</p>
								</div>
							)}
						</div>
					</div>
					<footer className="schema-sync-foot">
						{failure && (
							<button type="button" className="secondary" onClick={askAi}>
								<Icon name="sparkle" /> Ask {ASSISTANT_NAME} to fix
							</button>
						)}
						<span className="spacer" />
						<button type="button" className="secondary" onClick={() => void recompute()} disabled={busy} title="Re-introspect the target and rebuild the diff (use after fixing the cause, e.g. clearing duplicate rows).">
							<Icon name={busy ? 'loading' : 'refresh'} className={busy ? 'codicon-modifier-spin' : undefined} /> Resync
						</button>
						<button type="button" className="secondary" onClick={removeApplied}><Icon name="arrow-left" /> Back to changes</button>
						{failure && !failure.rolledBack && <button type="button" className="secondary" onClick={skip}><Icon name="debug-step-over" /> Skip</button>}
						<button type="button" className="secondary" onClick={props.onClose}><Icon name="debug-stop" /> Stop</button>
						{failure && <button type="button" onClick={retry}><Icon name="refresh" /> Retry</button>}
					</footer>
				</>
			)}

			{phase === 'done' && (
				<div className="schema-sync-empty">
					<Icon name="check-all" className="schema-sync-empty-icon" />
					<h2>Migration applied</h2>
					<p className="confirm-detail">Applied {lastApplied} statement{lastApplied === 1 ? '' : 's'} to {targetConfig?.label}. The databases are in sync.</p>
					<div className="schema-sync-pick-actions">
						<button type="button" onClick={props.onClose}><Icon name="check" /> Done</button>
					</div>
				</div>
			)}

			{confirmDialog}
		</div>
	);
}
