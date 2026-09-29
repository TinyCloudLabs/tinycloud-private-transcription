import { lstat, mkdir, readdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";

/**
 * On-disk layout under BATCH_UPLOAD_DIR:
 *   jobs/<trn_id>/upload-<lease>.part   an in-flight PUT (one per live lease)
 *   jobs/<trn_id>/audio-<lease>         the accepted recording (named in transcriptions.audio_file)
 *   jobs/<trn_id>/work-<generation>/    PCM for one worker claim
 * Only a PUT holding a live lease creates the job directory, and nothing ever creates it recursively, so
 * once deletion removes it a fenced-out worker cannot recreate artifacts inside it.
 */
export const jobsRoot = (root: string) => join(root, "jobs");
export const jobDir = (root: string, id: string) => join(jobsRoot(root), id);
export const tempUploadName = (lease: string) => `upload-${lease}.part`;
export const audioName = (lease: string) => `audio-${lease}`;
export const workDirName = (generation: number) => `work-${generation}`;

export async function ensureStorageRoot(root: string) {
  await mkdir(jobsRoot(root), { recursive: true, mode: 0o700 });
}

/** Creates the job directory (never its parents). */
export async function createJobDir(root: string, id: string) {
  try {
    await mkdir(jobDir(root, id), { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

const missing = async (path: string) => {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
};

/** Removes every artifact of a job and verifies ENOENT. Returns false when something is still present. */
export async function removeJobArtifacts(root: string, id: string): Promise<boolean> {
  await rm(jobDir(root, id), { recursive: true, force: true });
  return missing(jobDir(root, id));
}

/** Removes one entry inside a job directory and verifies ENOENT. */
export async function removeJobEntry(root: string, id: string, name: string): Promise<boolean> {
  const path = join(jobDir(root, id), name);
  await rm(path, { recursive: true, force: true });
  return missing(path);
}

export async function listJobDirs(root: string): Promise<string[]> {
  try {
    return await readdir(jobsRoot(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function listJobEntries(root: string, id: string): Promise<string[]> {
  try {
    return await readdir(jobDir(root, id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Used percentage of the upload volume, counting blocks reserved for root as used. */
export async function diskUsedPercent(root: string): Promise<number> {
  const s = await statfs(root);
  if (!s.blocks) return 100;
  return Math.round((1 - s.bavail / s.blocks) * 1000) / 10;
}
