/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  How much of a pull request the reviewer will read.
 *
 *  The input is somebody else's: a diff, file contents and statements of any size. Nothing in
 *  the reviewer is unsafe on a large input, but the cost grows with it, and a host serving many
 *  repositories should not spend a minute on one generated 200 MB dump. So there are caps, and
 *  every one that is hit is SAID in the review: a reviewer that quietly reads half a pull
 *  request and reports "nothing to flag" is worse than one that says it stopped.
 *--------------------------------------------------------------------------------------------*/

export interface ReviewLimits {
	/** Characters of unified diff. Over this, nothing is reviewed. */
	diffChars: number;
	/** Characters of one file's full content. Over this, the file is read from its added lines. */
	fileChars: number;
	/** Touched statements reviewed in one pull request; the rest are listed as not reviewed. */
	statements: number;
	/** Characters in one statement. A longer one is not parsed or probed. */
	statementChars: number;
}

export const DEFAULT_REVIEW_LIMITS: ReviewLimits = {
	diffChars: 5_000_000,
	fileChars: 2_000_000,
	statements: 1_000,
	statementChars: 100_000,
};

export function resolveLimits(overrides?: Partial<ReviewLimits>): ReviewLimits {
	return { ...DEFAULT_REVIEW_LIMITS, ...(overrides ?? {}) };
}

/** A size a reader can take in: `4.8 MB`, `120,000 characters`. */
export function describeSize(chars: number): string {
	if (chars >= 1_000_000) {
		return `${(chars / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`;
	}
	return `${chars.toLocaleString('en-US')} characters`;
}
