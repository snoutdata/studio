/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';
import { Icon } from './Icon';
import { MONGO_STAGES, pipelineFromStages, stagesFromPipeline, type BuilderStage } from '../pipeline';

// The visual staged-aggregation builder: edit a Mongo pipeline as a list of
// stages you can add, reorder, enable/disable, and edit, over the same pipeline model the JSON editor
// uses. "Run to here" runs the enabled stages up to and including a stage so you can see each step's
// output in the grid (per-stage preview). Applying writes the enabled stages back as pipeline JSON.

interface PipelineBuilderProps {
	/** The current pipeline (parsed from the editor buffer) to seed the builder. */
	initial: object[];
	/** Whether a target collection + connection are ready to run a preview. */
	canRun: boolean;
	/** Run the enabled stages up to (and including) `count` stages — the per-stage preview. */
	onRunTo(pipeline: object[]): void;
	/** Persist the enabled stages back to the editor as pipeline JSON. */
	onApply(pipeline: object[]): void;
	onClose(): void;
}

/** A stage with a stable client id, so reordering/deleting doesn't confuse React keys. */
interface Stage extends BuilderStage {
	id: number;
}

let stageSeq = 0;

export function PipelineBuilder({ initial, canRun, onRunTo, onApply, onClose }: PipelineBuilderProps): JSX.Element {
	const [stages, setStages] = useState<Stage[]>(() => stagesFromPipeline(initial).map((s) => ({ ...s, id: ++stageSeq })));
	const [error, setError] = useState<string | null>(null);

	function update(id: number, patch: Partial<Stage>): void {
		setStages((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
	}
	function addStage(): void {
		setStages((prev) => [...prev, { id: ++stageSeq, operator: '$match', body: '{}', enabled: true }]);
	}
	function remove(id: number): void {
		setStages((prev) => prev.filter((s) => s.id !== id));
	}
	function move(index: number, delta: number): void {
		setStages((prev) => {
			const next = [...prev];
			const j = index + delta;
			if (j < 0 || j >= next.length) {
				return prev;
			}
			[next[index], next[j]] = [next[j], next[index]];
			return next;
		});
	}

	/** Compile the enabled stages up to `upto` (exclusive count); on a parse error set the message and
	 *  return null so the caller aborts. `upto` undefined compiles all. */
	function compile(upto?: number): object[] | null {
		try {
			const slice = upto === undefined ? stages : stages.slice(0, upto);
			const pipeline = pipelineFromStages(slice);
			setError(null);
			return pipeline;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return null;
		}
	}

	function runTo(index: number): void {
		const pipeline = compile(index + 1);
		if (pipeline) {
			onRunTo(pipeline);
		}
	}
	function apply(): void {
		const pipeline = compile();
		if (pipeline) {
			onApply(pipeline);
			onClose();
		}
	}

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal pipeline-builder" onClick={(e) => e.stopPropagation()}>
				<div className="modal-head">
					<h2>Pipeline stages</h2>
					<button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
				</div>
				<div className="pb-stages">
					{stages.length === 0 && <div className="pb-empty">No stages. Add one to start the pipeline.</div>}
					{stages.map((stage, i) => (
						<div className={`pb-stage${stage.enabled ? '' : ' disabled'}`} key={stage.id}>
							<div className="pb-stage-head">
								<span className="pb-stage-num">{i + 1}</span>
								<input
									className="pb-op"
									list="pb-operators"
									value={stage.operator}
									spellCheck={false}
									onChange={(e) => update(stage.id, { operator: e.target.value })}
									title="Stage operator"
								/>
								<span className="spacer" />
								<label className="pb-enable" title={stage.enabled ? 'Disable this stage (kept, excluded from the run)' : 'Enable this stage'}>
									<input type="checkbox" checked={stage.enabled} onChange={(e) => update(stage.id, { enabled: e.target.checked })} />
									on
								</label>
								<button type="button" className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="chevron-up" /></button>
								<button type="button" className="icon-btn" aria-label="Move down" disabled={i === stages.length - 1} onClick={() => move(i, 1)}><Icon name="chevron-down" /></button>
								<button type="button" className="icon-btn" aria-label="Run the pipeline up to and including this stage" disabled={!canRun || !stage.enabled} onClick={() => runTo(i)}><Icon name="play" /></button>
								<button type="button" className="icon-btn" aria-label="Delete this stage" onClick={() => remove(stage.id)}><Icon name="trash" /></button>
							</div>
							<textarea
								className="pb-body"
								value={stage.body}
								spellCheck={false}
								rows={Math.min(8, Math.max(2, stage.body.split('\n').length))}
								onChange={(e) => update(stage.id, { body: e.target.value })}
							/>
						</div>
					))}
					<datalist id="pb-operators">
						{MONGO_STAGES.map((op) => <option key={op} value={op} />)}
					</datalist>
				</div>
				<button type="button" className="pb-add secondary" onClick={addStage}><Icon name="add" /> Add stage</button>
				{error && <div className="results-error">{error}</div>}
				<div className="modal-actions">
					<button type="button" className="secondary" onClick={onClose}><Icon name="close" /> Cancel</button>
					<span className="spacer" />
					<button type="button" onClick={apply}><Icon name="check" /> Apply to editor</button>
				</div>
			</div>
		</div>
	);
}
