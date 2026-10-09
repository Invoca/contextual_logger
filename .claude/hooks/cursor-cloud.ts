import { existsSync } from 'node:fs';

/**
 * Cursor Cloud Agent VM. Required signals: both structural paths
 * /exec-daemon (Cursor's exec helper) and /workspace (Cloud checkout root).
 * CURSOR_AGENT is NOT required — exec-daemon injects it only into Shell
 * children, not into hook subprocesses, so requiring it produces false
 * negatives on real Cloud VMs. No environment variable gates this check.
 * Not ADLC_CLOUD — that flag is a Polaris rollout switch and must not be
 * required for ADLC-on consumers (Titan, web).
 *
 * Tests inject `exists`. There is no production env opt-in for the probe path.
 *
 * Ambiguity posture (Gabe + pmoody): once both structural signals exist,
 * treat as Cloud and fail-open in the hooks that call this helper.
 * Missing either signal is not Cloud, so a laptop cannot flip on a
 * single moved implementation detail.
 */
export type PathExists = (path: string) => boolean;

export function isCursorCloud(exists: PathExists = existsSync): boolean {
  return exists('/exec-daemon') && exists('/workspace');
}
