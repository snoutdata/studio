/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

// Small pieces every section of a project's tab uses, local or cloud (shared/projects.ts).

/** What the last action said. `refused`: the app or the control plane stopped it, rather than it failing. */
export type Said = { ok: boolean; message: string; refused?: boolean } | null;

/** What the last action said: quiet when it worked, amber when it was refused, red when it failed. */
export function Status({ said }: { said: Said }): JSX.Element | null {
	if (!said) {
		return null;
	}
	return <div className={said.ok ? 'field-hint' : said.refused ? 'form-status warn' : 'form-status error'}>{said.message}</div>;
}

/** Streamed output, kept scrolled to the end. */
export function Log({ lines }: { lines: string[] }): JSX.Element | null {
	const ref = useRef<HTMLPreElement | null>(null);
	useEffect(() => {
		ref.current?.scrollTo({ top: ref.current.scrollHeight });
	}, [lines.length]);
	return lines.length > 0 ? <pre className="local-log" ref={ref}>{lines.join('\n')}</pre> : null;
}

/** Progress lines for one project, from the moment the component subscribed. */
export function useProgressLines(projectId: string): { lines: string[]; clear(): void } {
	const [lines, setLines] = useState<string[]>([]);
	useEffect(() => window.sqlApi.local.onProgress((p) => {
		if (p.installId === projectId && p.line) {
			setLines((prev) => [...prev, p.line as string].slice(-300));
		}
	}), [projectId]);
	return { lines, clear: () => setLines([]) };
}

/** Load something, with the error kept as a sentence and a way to load it again. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload(): Promise<void> } {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const reload = useCallback(async () => {
		setLoading(true);
		try {
			setData(await load());
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, deps);
	useEffect(() => {
		void reload();
	}, [reload]);
	return { data, error, loading, reload };
}

/** Previous / next over a page of `size`, where the query fetched `size + 1` to know if there is more. */
export function Pager(props: { page: number; hasMore: boolean; onPage(page: number): void }): JSX.Element | null {
	if (props.page === 0 && !props.hasMore) {
		return null;
	}
	return (
		<div className="cloud-actions">
			<button type="button" className="secondary small" disabled={props.page === 0} onClick={() => props.onPage(props.page - 1)}><Icon name="chevron-left" /> Previous</button>
			<span className="muted small">Page {props.page + 1}</span>
			<button type="button" className="secondary small" disabled={!props.hasMore} onClick={() => props.onPage(props.page + 1)}><Icon name="chevron-right" /> Next</button>
		</div>
	);
}
