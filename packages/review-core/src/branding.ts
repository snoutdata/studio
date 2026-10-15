/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The one place the product is named.
 *
 *  The reviewer does not have a name yet, and the handle it answers to has to be configurable
 *  regardless of the name (a self-hosted install may want its own). So every other module takes
 *  branding as an argument and nothing else in this package contains a product name, a URL or a
 *  handle. Choosing the name is an edit to `DEFAULT_BRANDING` and nothing else.
 *--------------------------------------------------------------------------------------------*/

export interface Branding {
	/** The handle a comment mentions to summon a review, WITHOUT the leading `@`. */
	handle: string;
	/** How the reviewer signs the comment it posts. */
	displayName: string;
	/** Where a reader is sent to learn what it is. Empty string = no link is rendered. */
	url: string;
	/** Where a reader is sent to connect a destination database. Empty string = no link. */
	connectUrl: string;
}

/** Working name: **Snoutbot**. Chosen for the HANDLE first — `@snoutbot review` reads the way a
 *  bot mention should — with the product name still open. Changing either is an edit to this
 *  object and nothing else. */
export const DEFAULT_BRANDING: Branding = {
	handle: 'snoutbot',
	displayName: 'Snoutbot',
	url: '',
	connectUrl: '',
};

/** Fill in whatever the caller left out. */
export function resolveBranding(partial?: Partial<Branding>): Branding {
	return { ...DEFAULT_BRANDING, ...partial };
}
