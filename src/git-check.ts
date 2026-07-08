/**
 * Git installation detection.
 *
 * Spawns `git --version` at startup (and on demand) so the Settings UI can
 * show whether Git is available on the user's machine. Result is cached —
 * we don't fork a process on every UI poll.
 */
import { execFile } from "child_process";
import { logger } from "./logger";

export interface GitStatus {
  installed: boolean;
  version?: string;
  error?:   string;
  checkedAt: number;
}

let cached: GitStatus | null = null;
let inFlight: Promise<GitStatus> | null = null;

function runGitVersion(): Promise<GitStatus> {
  return new Promise((resolve) => {
    execFile("git", ["--version"], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({ installed: false, error: err.message, checkedAt: Date.now() });
        return;
      }
      const raw = String(stdout || "").trim();
      const m = raw.match(/git version\s+(\S+)/i);
      resolve({ installed: true, version: m ? m[1] : raw, checkedAt: Date.now() });
    });
  });
}

/** Re-run the detection and update the cache. */
export async function refreshGitStatus(): Promise<GitStatus> {
  if (inFlight) return inFlight;
  inFlight = runGitVersion().then((s) => {
    cached = s;
    inFlight = null;
    if (s.installed) logger.info(`[git-check] git detected: ${s.version}`);
    else             logger.warn(`[git-check] git not detected: ${s.error}`);
    return s;
  });
  return inFlight;
}

/** Return the cached status, kicking off a refresh if we've never checked. */
export function getGitStatus(): GitStatus | null {
  if (cached === null && !inFlight) void refreshGitStatus();
  return cached;
}
