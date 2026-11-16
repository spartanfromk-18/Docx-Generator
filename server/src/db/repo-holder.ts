/**
 * Process-wide repository singleton. Initialized once at startup (index.ts)
 * with `setRepo(await createRepo())`; every module imports the live binding `repo`.
 */
import type { Repo } from "./repo.js";

export let repo: Repo;

export function setRepo(instance: Repo): void {
  repo = instance;
}

export function getRepo(): Repo {
  if (!repo) throw new Error("Repository not initialized — call setRepo() at startup first.");
  return repo;
}
