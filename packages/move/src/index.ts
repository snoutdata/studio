/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export {
	isNewEndpoint,
	newMoveSpec,
	sameEndpoint,
	validateMove,
	type DriverId,
	type ExtensionExclusion,
	type FixId,
	type MoveContent,
	type MoveEndpoint,
	type MoveSelection,
	type MoveSpec,
	type ResolvedFinding,
	type SchemaExclusion,
	type SourceAfter,
	type TableExclusion,
	type TargetMode
} from './spec.js';
export { strategyFor, type MoveStrategy } from './strategy.js';
export type { DatabaseObject, DatabaseObjectKind, EndpointFacts, ExtensionTable, MoveFacts, SchemaFacts } from './facts.js';
export {
	estimatedBytes,
	formatBytes,
	preflight,
	readyToRun,
	requiredToolMajor,
	selectedSchemas,
	type Finding,
	type FindingId,
	type Severity
} from './preflight.js';
export { applyFix, findFinding, type FixResult } from './fixes.js';
export { conninfoDatabase, nativePgArgs, quotePattern, type PgToolArgs } from './pgArgs.js';
export { quoteIdent, replacePlan, type ReplacePlan } from './replace.js';
export { HOSTED_POSTGRES_MAJOR, HOSTED_POSTGRES_PLATFORM, NO_PLATFORM, type PlatformProfile } from './platform.js';
export {
	PG_FACTS_SQL,
	endpointFactsFromPg,
	newDatabaseFactsFromPg,
	newHostedProjectFacts,
	pgServerFactsSql,
	quoteLiteral,
	type HostFacts
} from './pgFacts.js';
export { ToolLog, type RestoreFailure, type ToolLogEvent } from './toolLog.js';
export {
	chunks,
	copyProgressFromPg,
	createDatabaseSql,
	PG_COPY_PROGRESS_SQL,
	pgRowCountsSql,
	pgSequencesSql,
	pgTableSizesSql,
	sequencesFromPg,
	tableCountsFromPg,
	tableEstimatesFromPg,
	type CopyProgress,
	type SequenceValue,
	type TableCount,
	type TableEstimate,
	type TableRef
} from './runSql.js';
export {
	describeRun,
	runStatus,
	verifySequences,
	verifyTables,
	type MoveRunResult,
	type MoveRunStatus,
	type SequenceVerification,
	type TableVerification
} from './report.js';
export {
	etaSeconds,
	formatDuration,
	isActivePhase,
	overallFraction,
	tableFraction,
	type MovePhase,
	type MoveProgress,
	type MoveTableProgress
} from './progress.js';
