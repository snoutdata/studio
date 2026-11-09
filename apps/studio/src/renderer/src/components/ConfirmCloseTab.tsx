/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';
import { useI18n } from '../i18n';

interface ConfirmCloseTabProps {
	title: string;
	onConfirm(): void;
	onCancel(): void;
}

/** Themed "discard unsaved changes" prompt for closing a dirty editor tab — mirrors the
 *  quit dialog so we never fall back to the OS confirm box. */
export function ConfirmCloseTab(props: ConfirmCloseTabProps): JSX.Element {
	const { t, tr } = useI18n();
	return (
		<div className="modal-backdrop" onClick={props.onCancel}>
			<div className="modal confirm" onClick={(e) => e.stopPropagation()}>
				<h2 className="danger">
					<Icon name="warning" />
					{t('shell.confirmClose.title')}
				</h2>
				<p className="confirm-detail">
					{tr('shell.confirmClose.body', { name: props.title })}
				</p>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={props.onCancel} autoFocus><Icon name="close" /> {t('shell.common.cancel')}</button>
					<button type="button" className="danger" onClick={props.onConfirm}><Icon name="discard" /> {t('shell.confirmClose.discard')}</button>
				</div>
			</div>
		</div>
	);
}
