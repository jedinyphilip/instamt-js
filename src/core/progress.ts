/**
 * Progress reporting for long-running pipeline stages. Stages that have
 * countable units (per-frame loops) report current/total; stages without
 * report just `phase` and the progress bar goes indeterminate.
 */

export type Phase =
  | 'reading'
  | 'cleanup'
  | 'detection'
  | 'tracking'
  | 'lineages'
  | 'kymographs'
  | 'metrics'
  | 'writing';

// Named PipelineProgress to avoid clashing with the DOM's global
// ProgressEvent (used by XHR/fetch). They're not related; we're not
// extending or implementing it.
export interface PipelineProgress {
  phase: Phase;
  /** Optional sub-label, e.g. channel name during cleanup. */
  channel?: string;
  /** 0-based; undefined means indeterminate. */
  current?: number;
  total?: number;
  message?: string;
}

export type ProgressCallback = (ev: PipelineProgress) => void;

export const noop: ProgressCallback = () => {};
