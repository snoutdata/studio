/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';

interface PipelineBarProps {
	/** Which authoring surface the active tab is on. */
	surface: 'sql' | 'native';
	/** Collection names from the connection's schema, for the native target picker. */
	collections: string[];
	/** The target collection of the native pipeline (only used when `surface` is native). */
	collection?: string;
	onSurfaceChange(surface: 'sql' | 'native'): void;
	onCollectionChange(name: string): void;
	/** Whether the lightweight find bar is open. */
	findOpen?: boolean;
	/** Toggle the find bar. Omit to hide the Find button (e.g. no collections yet). */
	onToggleFind?(): void;
	/** Open the visual staged-pipeline builder (native surface only). */
	onOpenBuilder?(): void;
	/** Explain the current native pipeline (native surface only). */
	onExplain?(): void;
}

/**
 * The MongoDB authoring-surface control: a SQL/Pipeline switch plus, on the
 * native surface, the target-collection picker (a Mongo aggregation runs against one collection,
 * the way SQL names it in FROM). Rendered in the editor toolbar only for document connections.
 */
export function PipelineBar({ surface, collections, collection, onSurfaceChange, onCollectionChange, findOpen = false, onToggleFind, onOpenBuilder, onExplain }: PipelineBarProps): JSX.Element {
	return (
		<span className="pipeline-bar" title="MongoDB query surface">
			{onToggleFind && (
				<button
					type="button"
					className={`surface-find${findOpen ? ' active' : ''}`}
					aria-pressed={findOpen}
					onClick={onToggleFind}
					title="Quick find: filter, project, sort without writing a pipeline"
				>
					<Icon name="search" /> Find
				</button>
			)}
			<span className="surface-switch" role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={surface === 'sql'}
					className={surface === 'sql' ? 'active' : ''}
					onClick={() => onSurfaceChange('sql')}
					title="Write SQL (translated to an aggregation pipeline)"
				>
					SQL
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={surface === 'native'}
					className={surface === 'native' ? 'active' : ''}
					onClick={() => onSurfaceChange('native')}
					title="Write a native aggregation pipeline (JSON)"
				>
					Pipeline
				</button>
			</span>
			{surface === 'native' && (
				<span className="pipeline-collection" title="Collection this pipeline runs against">
					<Icon name="symbol-field" />
					<select value={collection ?? ''} onChange={(e) => onCollectionChange(e.target.value)}>
						{collection === undefined || collection === '' ? <option value="">Collection…</option> : null}
						{collections.map((c) => (
							<option key={c} value={c}>{c}</option>
						))}
					</select>
				</span>
			)}
			{surface === 'native' && onOpenBuilder && (
				<button type="button" className="surface-find" onClick={onOpenBuilder} title="Edit the pipeline as visual stages (add, reorder, disable, preview each step)">
					<Icon name="list-tree" /> Stages
				</button>
			)}
			{surface === 'native' && onExplain && (
				<button type="button" className="surface-find" onClick={onExplain} title="Explain this pipeline: show the query plan (which index it uses) without running it">
					<Icon name="dashboard" /> Explain
				</button>
			)}
		</span>
	);
}
