/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';
import { useT } from '../i18n';

// A small, non-interactive connection indicator: a status dot (green when connected, red
// flag for prod) plus the connection label. Read-only views (TableView, ObjectView) show
// this in their header so the user always knows which connection they're looking at, even
// though those tabs have no run/picker toolbar.
export function ConnectionChip({ label, connected, prod }: { label: string; connected: boolean; prod: boolean }): JSX.Element {
	const t = useT();
	return (
		<span className="tv-conn" title={connected ? label : t('editor.common.notConnected', { label })}>
			<span className={`dot${connected ? ' on' : ''}${prod ? ' prod' : ''}`}><Icon name="circle-filled" /></span>
			<span className="tv-conn-label">{label}</span>
		</span>
	);
}
