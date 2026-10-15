/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export interface ConfirmOptions {
	title: string;
	/** Optional explanatory body. Plain text or arbitrary nodes. */
	body?: ReactNode;
	/** Confirm button label (default "OK"). */
	confirmLabel?: string;
	/** Cancel button label (default "Cancel"). */
	cancelLabel?: string;
	/** Style the title + confirm button as destructive. */
	danger?: boolean;
	/** Codicon name for the title glyph. Defaults to "warning" when danger, else "question". */
	icon?: string;
}

interface ConfirmDialogProps extends ConfirmOptions {
	onConfirm(): void;
	onCancel(): void;
}

/** Themed confirmation modal, mirroring ConfirmQuit/ConfirmRun, so we never fall back to
 *  the OS confirm box. Usually driven through useConfirm() rather than rendered directly. */
export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element {
	const { onConfirm, onCancel } = props;
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') {
				onCancel();
			} else if (e.key === 'Enter') {
				onConfirm();
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onConfirm, onCancel]);

	return (
		<div className="modal-backdrop" onClick={onCancel}>
			<div className="modal confirm" onClick={(e) => e.stopPropagation()}>
				<h2 className={props.danger ? 'danger' : undefined}>
					<Icon name={props.icon ?? (props.danger ? 'warning' : 'question')} />
					{props.title}
				</h2>
				{props.body !== undefined && <div className="confirm-detail">{props.body}</div>}
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onCancel} autoFocus><Icon name="close" /> {props.cancelLabel ?? 'Cancel'}</button>
					<button type="button" className={props.danger ? 'danger' : ''} onClick={onConfirm}>{props.confirmLabel ?? 'OK'}</button>
				</div>
			</div>
		</div>
	);
}

interface Pending extends ConfirmOptions {
	resolve(result: boolean): void;
}

/** Promise-based replacement for window.confirm. Returns a `confirm(options)` that resolves
 *  to true/false, plus the dialog element to render somewhere in the component tree:
 *
 *  const [confirm, confirmDialog] = useConfirm();
 *  if (!(await confirm({ title: "Delete?" , danger: true }))) return;
 *  ...later in JSX: {confirmDialog}
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, JSX.Element | null] {
	const [pending, setPending] = useState<Pending | null>(null);

	const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
		return new Promise<boolean>((resolve) => {
			setPending({ ...options, resolve });
		});
	}, []);

	function settle(result: boolean): void {
		setPending((p) => {
			p?.resolve(result);
			return null;
		});
	}

	const dialog = pending
		? <ConfirmDialog {...pending} onConfirm={() => settle(true)} onCancel={() => settle(false)} />
		: null;

	return [confirm, dialog];
}
