import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

import * as api from "./api";

interface DeployProgress {
  done: number;
  total: number;
  name: string;
}

/**
 * Run a long deploy operation (upload / sync / batch download) with a
 * progress toast that shows "done/total" and a Cancel button.
 *
 * `run(jobId)` must invoke the backend command, passing the given jobId,
 * and resolve with the success message to show when it finishes. The
 * backend emits `deploy-progress://{jobId}` events which drive the toast,
 * and honours `cancel_deploy(jobId)` to stop early.
 */
export interface DeployJobContext {
  jobId: string;
  /** True once the user has pressed Cancel — batch loops should stop. */
  cancelled: () => boolean;
}

export async function runDeployJob(
  label: string,
  run: (ctx: DeployJobContext) => Promise<string>,
): Promise<void> {
  const jobId = crypto.randomUUID();
  const toastId = `deploy-${jobId}`;
  let cancelled = false;

  const render = (msg: string) =>
    toast.loading(msg, {
      id: toastId,
      duration: Infinity,
      action: {
        label: "Cancel",
        onClick: () => {
          cancelled = true;
          void api.cancelDeploy(jobId);
          toast.loading(`Cancelling ${label}…`, { id: toastId, duration: Infinity });
        },
      },
    });

  render(`${label}…`);

  const unlisten = await listen<DeployProgress>(
    `deploy-progress://${jobId}`,
    (e) => {
      if (cancelled) return;
      const { done, total, name } = e.payload;
      const base = name.split("/").pop() || name;
      render(`${label} ${done}/${total} — ${base}`);
    },
  );

  try {
    const summary = await run({ jobId, cancelled: () => cancelled });
    if (cancelled) {
      toast.info(`${label} cancelled`, { id: toastId, duration: 4000, action: undefined });
    } else {
      // Done — drop the Cancel action and auto-dismiss after 30s (still
      // has a close button if the user wants it gone sooner).
      toast.success(summary, {
        id: toastId,
        duration: 30_000,
        closeButton: true,
        action: undefined,
      });
    }
  } catch (e) {
    toast.error(`${e}`, {
      id: toastId,
      duration: 30_000,
      closeButton: true,
      action: undefined,
    });
  } finally {
    unlisten();
  }
}
