import type { DetectConfig } from '../microtubules/detect';
import type { KymographResult } from '../microtubules/kymograph';
import type { Track } from '../microtubules/track';
import type { Shape3D } from '../types';
import type { WorkerRequest, WorkerResponse } from './pipeline.worker';

export interface FrameJobConfig {
  fftCutoffPixels: number;
  fringeWindow: number;
  fringeBoost: number;
  contrast: number;
  nlmHFactor: number;
  nlmPatch: number;
  nlmSearch: number;
  detect: DetectConfig;
  /** 'cleanup' = bg/fringe/denoise + return per-frame median.
   *  'detectWithShift' = apply shift to the input frame, then run detect.
   *  'both' = legacy single-pass mode (kept for compatibility). */
  mode: 'cleanup' | 'detectWithShift' | 'both';
  /** Required when mode='detectWithShift'. */
  shift?: number;
}

export interface FrameResult {
  cleaned: Float32Array;
  filaments: Float32Array[] | null;
  /** Set for mode='cleanup'. */
  perFrameMedian?: number;
}

export interface KymographJob {
  irmShape: Shape3D;
  /** SAB-backed Float32Array. Workers read shared memory, no copy. */
  irmData: Float32Array;
  fluorData: Float32Array;
  members: Track[];
  thickness: number;
  step: number;
}

/**
 * Pool of pipeline workers. Frames are dispatched in submission order
 * and yielded back in completion order; the caller is expected to
 * tolerate out-of-order completion (the orchestrator stitches by
 * frame index it sent).
 *
 * The pool is generic over mode: per-frame cleanup/detect jobs and
 * per-lineage kymograph jobs share the same worker pool, so they
 * naturally fight over the same N workers and never both run at once.
 */
export class WorkerPool {
  private workers: Worker[];
  private idle: Worker[];
  private queue: Array<{
    req: WorkerRequest;
    transfer: Transferable[];
    resolve: (r: WorkerResponse) => void;
    reject: (e: unknown) => void;
  }> = [];
  private inflight = new Map<
    number,
    {
      resolve: (r: WorkerResponse) => void;
      reject: (e: unknown) => void;
      workerIndex: number;
    }
  >();
  private nextJobId = 0;

  constructor(size: number) {
    this.workers = [];
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./pipeline.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.workers.push(w);
    }
    this.idle = [...this.workers];

    this.workers.forEach((w, idx) => {
      w.addEventListener('message', (ev: MessageEvent<WorkerResponse>) => {
        const resp = ev.data;
        const inflight = this.inflight.get(resp.jobId);
        if (!inflight) return;
        this.inflight.delete(resp.jobId);
        this.idle.push(this.workers[inflight.workerIndex]!);
        inflight.resolve(resp);
        this.dispatch();
      });
      w.addEventListener('error', (ev) => {
        const reason = ev.message ?? 'worker error';
        for (const [id, h] of this.inflight) {
          if (h.workerIndex === idx) {
            this.inflight.delete(id);
            h.reject(new Error(reason));
          }
        }
      });
    });
  }

  /** Submit a per-frame cleanup/detect job. */
  submit(
    frame: Float32Array,
    width: number,
    height: number,
    cfg: FrameJobConfig
  ): Promise<FrameResult> {
    const jobId = this.nextJobId++;
    let req: WorkerRequest;
    if (cfg.mode === 'cleanup') {
      req = {
        jobId,
        mode: 'cleanup',
        frame,
        width,
        height,
        fftCutoffPixels: cfg.fftCutoffPixels,
        fringeWindow: cfg.fringeWindow,
        fringeBoost: cfg.fringeBoost,
        contrast: cfg.contrast,
        nlmHFactor: cfg.nlmHFactor,
        nlmPatch: cfg.nlmPatch,
        nlmSearch: cfg.nlmSearch,
      };
    } else if (cfg.mode === 'detectWithShift') {
      req = {
        jobId,
        mode: 'detectWithShift',
        frame,
        width,
        height,
        shift: cfg.shift ?? 0,
        detect: cfg.detect,
      };
    } else {
      req = {
        jobId,
        mode: 'both',
        frame,
        width,
        height,
        fftCutoffPixels: cfg.fftCutoffPixels,
        fringeWindow: cfg.fringeWindow,
        fringeBoost: cfg.fringeBoost,
        contrast: cfg.contrast,
        nlmHFactor: cfg.nlmHFactor,
        nlmPatch: cfg.nlmPatch,
        nlmSearch: cfg.nlmSearch,
        detect: cfg.detect,
      };
    }
    return this.enqueue(req, [frame.buffer]).then((resp) => ({
      cleaned: resp.cleaned!,
      filaments: resp.filaments ?? null,
      ...(resp.perFrameMedian !== undefined ? { perFrameMedian: resp.perFrameMedian } : {}),
    }));
  }

  /** Submit a per-lineage kymograph job. SAB stacks aren't transferred
   *  (shared memory), so the request is structuredCloned by default —
   *  but the SAB-backed Float32Arrays just pass the SharedArrayBuffer
   *  reference, not the data. Per-job clone cost is bounded by the
   *  Track objects' arc data, typically a few MB. */
  submitKymograph(job: KymographJob): Promise<KymographResult | null> {
    const jobId = this.nextJobId++;
    const req: WorkerRequest = {
      jobId,
      mode: 'kymograph',
      irmShape: job.irmShape,
      irmData: job.irmData,
      fluorData: job.fluorData,
      members: job.members,
      thickness: job.thickness,
      step: job.step,
    };
    return this.enqueue(req, []).then((resp) => resp.kymograph ?? null);
  }

  private enqueue(req: WorkerRequest, transfer: Transferable[]): Promise<WorkerResponse> {
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.queue.push({ req, transfer, resolve, reject });
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const job = this.queue.shift()!;
      const workerIndex = this.workers.indexOf(worker);
      this.inflight.set(job.req.jobId, {
        resolve: job.resolve,
        reject: job.reject,
        workerIndex,
      });
      worker.postMessage(job.req, job.transfer);
    }
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
  }
}
