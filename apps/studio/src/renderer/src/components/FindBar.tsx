/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';
import { Icon } from './Icon';
import { buildFindPipeline, type FindSpec } from '../pipeline';

// The lightweight find bar: a compact filter + projection + sort + limit
// strip for the ~90% of Mongo browsing that's neither full SQL nor a hand-written aggregation
// pipeline. It compiles to a find-shaped native pipeline (`[{$match},{$project},{$sort},{$limit}]`)
// via buildFindPipeline and hands it up to run against the target collection.

interface FindBarProps {
	/** Collection names for the target picker. */
	collections: string[];
	/** Target collection (the find runs against this one). */
	collection: string | undefined;
	onCollectionChange(name: string): void;
	/** Run the compiled find-shaped pipeline against the target collection. */
	onRun(collection: string, pipeline: object[]): void;
}

export function FindBar({ collections, collection, onCollectionChange, onRun }: FindBarProps): JSX.Element {
	const [spec, setSpec] = useState<FindSpec>({});
	const [limitText, setLimitText] = useState('50');
	const [error, setError] = useState<string | null>(null);

	function set<K extends keyof FindSpec>(key: K, value: FindSpec[K]): void {
		setSpec((s) => ({ ...s, [key]: value }));
	}

	function run(): void {
		if (!collection) {
			setError('Pick a collection to query.');
			return;
		}
		const limit = limitText.trim() ? Number(limitText.trim()) : undefined;
		if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
			setError('Limit must be a non-negative number.');
			return;
		}
		try {
			const pipeline = buildFindPipeline({ ...spec, limit });
			setError(null);
			onRun(collection, pipeline);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	// Enter in any field runs the find (mongo-shell muscle memory).
	function onKeyDown(e: React.KeyboardEvent): void {
		if (e.key === 'Enter') {
			e.preventDefault();
			run();
		}
	}

	return (
		<div className="find-bar">
			<div className="find-bar-row">
				<span className="find-collection" title="Collection to query">
					<Icon name="symbol-field" />
					<select value={collection ?? ''} onChange={(e) => onCollectionChange(e.target.value)}>
						{collection === undefined || collection === '' ? <option value="">Collection…</option> : null}
						{collections.map((c) => <option key={c} value={c}>{c}</option>)}
					</select>
				</span>
				<input
					className="find-input find-filter"
					placeholder={'Filter, e.g. { "status": "active" }'}
					value={spec.filter ?? ''}
					spellCheck={false}
					onChange={(e) => set('filter', e.target.value)}
					onKeyDown={onKeyDown}
					title="A Mongo query document (JSON). Blank matches every document."
				/>
				<button type="button" className="find-run" onClick={run} title="Run this find (Enter)"><Icon name="play" /> Find</button>
			</div>
			<div className="find-bar-row find-bar-row-2">
				<input
					className="find-input"
					placeholder="Fields, e.g. name, email, -_id"
					value={spec.project ?? ''}
					spellCheck={false}
					onChange={(e) => set('project', e.target.value)}
					onKeyDown={onKeyDown}
					title="Projection: bare names include, a - prefix excludes (e.g. -password). Blank returns whole documents."
				/>
				<input
					className="find-input"
					placeholder="Sort, e.g. createdAt:-1, name"
					value={spec.sort ?? ''}
					spellCheck={false}
					onChange={(e) => set('sort', e.target.value)}
					onKeyDown={onKeyDown}
					title="Sort keys: field or field:dir (1/asc or -1/desc)."
				/>
				<label className="find-limit" title="Maximum documents to return">
					Limit
					<input
						className="find-input"
						type="number"
						min={0}
						value={limitText}
						onChange={(e) => setLimitText(e.target.value)}
						onKeyDown={onKeyDown}
					/>
				</label>
			</div>
			{error && <div className="find-bar-error"><Icon name="warning" /> {error}</div>}
		</div>
	);
}
