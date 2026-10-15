/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  @snout/review-core — the database pull-request reviewer, as a library.
 *
 *  A diff goes in. Optionally, the destination's schema and the answers to some read-only
 *  questions go in with it. Findings and a markdown comment come out.
 *
 *  Two hard rules for anything added under this root, both of which the whole product shape
 *  depends on:
 *
 *    1. NO I/O. No network, no filesystem, no database, no dependencies. It is a rule set any
 *       host can run (the desktop app today, a CI runner or a service of someone's own) as the
 *       same code, and that is only true while this package cannot reach anything itself.
 *    2. IT DECIDES, IT DOES NOT FETCH. Anything it needs is passed in. When it is missing, the
 *       rule stays quiet and the report records a gap — a reviewer that guesses is worse than
 *       one that admits what it could not see.
 *--------------------------------------------------------------------------------------------*/

export { DEFAULT_BRANDING, resolveBranding } from './branding.js';
export type { Branding } from './branding.js';

export { commentaryPrompt, tidyPunctuation } from './commentary.js';
export type { CommentaryPromptOptions } from './commentary.js';

export { dialectFor, quoteName, GENERIC_DIALECT } from './dialect.js';
export type { ReviewDialect } from './dialect.js';

export {
	DEFAULT_EXCLUDE,
	DEFAULT_INCLUDE,
	isReviewablePath,
	parseDiff,
	reviewableFiles,
} from './diff.js';
export type { ChangedFile, FileStatus, PathFilter } from './diff.js';

export { DEFAULT_REVIEW_LIMITS } from './limits.js';
export type { ReviewLimits } from './limits.js';

export { PROBE_FAILURE_REASONS, probeFailureOf } from './failure.js';

export { codeFence, codeSpan, nameSpan } from './markdown.js';

export { parseMention } from './mention.js';
export type { ReviewCommand, ReviewCommandName } from './mention.js';

export { countFrom, planProbes, probeFindings } from './probes.js';
export type { ProbePlanInput } from './probes.js';

export { checkConclusion, COMMENT_MARKER, renderComment, renderHelp } from './report.js';
export type { RenderOptions } from './report.js';

export { planReview, review, reviewFiles } from './review.js';
export type { ReviewOptions, ReviewPlan } from './review.js';

export { allIndexes, coveringIndex, findColumn, findTable, hasLeadingIndex } from './schema.js';
export type {
	ColumnInfo,
	DatabaseSchema,
	ForeignKeyInfo,
	IndexInfo,
	RoutineInfo,
	TableInfo,
	TableStats,
	TriggerInfo,
} from './schema.js';

export { findAtDepth, LEGACY_LEX, maskSql, MYSQL_LEX, ORACLE_LEX, POSTGRES_LEX, splitAtDepth, SQLITE_LEX, SQLSERVER_LEX } from './sql/mask.js';
export type { MaskedSql, SqlLexRules } from './sql/mask.js';
export { parseStatement } from './sql/parse.js';
export type { AlterAction, DeclaredColumn, ParsedStatement, PredicateRef, StatementKind, TableRef } from './sql/parse.js';
export { singleStatementRefusal, splitStatements } from './sql/split.js';
export type { StatementSpan } from './sql/split.js';
export { tokenize } from './sql/tokenize.js';
export type { Token } from './sql/tokenize.js';

export { statementsForFile, touchedStatements } from './statements.js';
export type { FileStatements } from './statements.js';

export { decideTrigger, doneReaction, isOwnComment, renderFailure, touchesSql } from './triggers.js';
export type { Reaction, TriggerConfig, TriggerDecision, TriggerEvent, TriggerKind } from './triggers.js';

export type {
	Evidence,
	LocalProbeError,
	Probe,
	ProbeFailure,
	ProbeKind,
	ProbeResult,
	ReviewDepth,
	ReviewFinding,
	ReviewFindingKind,
	ReviewInput,
	ReviewReport,
	ReviewSeverity,
	ReviewStatement,
} from './types.js';
