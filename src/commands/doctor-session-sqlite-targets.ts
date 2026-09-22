/** Offline Doctor target discovery and legacy-source admission. */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isPrimarySessionTranscriptFileName } from "../config/sessions/artifacts.js";
import {
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreCandidateTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  resolveConfiguredAgentDatabaseTargets,
  resolveSessionStoreTargets,
  type SessionStoreTarget as ResolvedSessionStoreTarget,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createAgentDatabaseDeletionClassifier } from "../state/agent-deletion-discovery.js";
import { readAgentDatabaseDeletionSnapshot } from "../state/agent-deletion-journal.read.js";
import type { HistoricalArchiveSources } from "./doctor-session-sqlite-discovery.js";
import { canonicalMigrationFilePath } from "./doctor-session-sqlite-migration-run.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";
import type { DoctorSessionSqliteMode } from "./doctor-session-sqlite-types.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };

export function resolveDoctorSessionSqliteTargets(params: {
  allAgents?: boolean;
  agent?: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode: DoctorSessionSqliteMode;
  store?: string;
}): { targets: SessionStoreTarget[]; observedTargets: SessionStoreTarget[] } {
  if (params.store) {
    const targets = resolveSessionStoreTargets(
      params.cfg,
      { store: params.store },
      { env: params.env },
    );
    return { targets, observedTargets: targets };
  }
  const discoversHistory =
    params.mode === "dry-run" || params.mode === "import" || params.mode === "validate";
  if (
    params.mode === "restore" ||
    params.mode === "recover" ||
    (discoversHistory && params.agent)
  ) {
    const candidates = resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, {
      env: params.env,
    });
    if (!params.agent) {
      return { targets: candidates, observedTargets: candidates };
    }
    const requestedAgentId = normalizeAgentId(params.agent);
    const targets = candidates.filter(
      (target) => normalizeAgentId(target.agentId) === requestedAgentId,
    );
    return { targets, observedTargets: targets };
  }
  if (params.agent) {
    const targets = resolveAgentSessionStoreTargetsSync(params.cfg, params.agent, {
      env: params.env,
    });
    return { targets, observedTargets: targets };
  }
  if (params.allAgents) {
    // Discovery must admit validated directories even before either registry exists.
    const candidates = discoversHistory
      ? resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, { env: params.env })
      : resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env });
    const legacyStorePath = path.join(resolveStateDir(params.env), "sessions", "sessions.json");
    const legacyTargets =
      discoversHistory && fs.existsSync(legacyStorePath)
        ? resolveSessionStoreTargets(params.cfg, { allAgents: true }, { env: params.env }).map(
            (target) => ({
              agentId: target.agentId,
              sqlitePath: resolveTargetSqlitePath(target, params.env),
              storePath: legacyStorePath,
            }),
          )
        : [];
    // Legacy-only installs can predate shared state; existing history owns retained-store admission.
    const deletionSnapshot = readAgentDatabaseDeletionSnapshot(params.env);
    const isRetained =
      deletionSnapshot &&
      createAgentDatabaseDeletionClassifier({
        env: params.env,
        retainedDeletions: deletionSnapshot.retainedDeletions,
        registeredAgentDatabases: deletionSnapshot.registeredAgentDatabases,
        configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(params.cfg, {
          env: params.env,
        }),
      });
    // Held stores still contribute aliases and references, even though maintenance cannot select them.
    const observedTargets = [...legacyTargets, ...candidates];
    const targets = observedTargets.filter(
      (target) =>
        !isRetained?.(target.storePath, target.agentId) &&
        !isRetained?.(resolveTargetSqlitePath(target, params.env), target.agentId),
    );
    return { targets, observedTargets };
  }
  const targets = resolveSessionStoreTargets(params.cfg, {}, { env: params.env });
  return { targets, observedTargets: targets };
}

export function filterLegacySessionStoreTargets(
  targets: SessionStoreTarget[],
  mode: DoctorSessionSqliteMode,
  historicalArchives: HistoricalArchiveSources,
  settledStores: ReadonlySet<string>,
): SessionStoreTarget[] {
  if (mode === "inspect" || mode === "compact" || mode === "restore" || mode === "recover") {
    return targets;
  }
  return targets.filter(
    (target) =>
      !target.storePath.endsWith(".sqlite") &&
      (settledStores.has(target.storePath) ||
        fs.existsSync(target.storePath) ||
        (historicalArchives.get(canonicalMigrationFilePath(target.storePath))?.transcripts.length ??
          0) > 0 ||
        (fs.existsSync(path.dirname(target.storePath)) &&
          fs.readdirSync(path.dirname(target.storePath)).some(isPrimarySessionTranscriptFileName))),
  );
}

export function resolveDoctorSessionSqliteMaintenancePaths(
  targets: readonly SessionStoreTarget[],
): string[] {
  const protectedPaths = new Set<string>();
  for (const target of targets) {
    for (const databasePath of resolveSqliteDatabaseFilePaths(resolveTargetSqlitePath(target))) {
      protectedPaths.add(databasePath);
    }
  }
  return [...protectedPaths];
}

export function resolveDoctorSessionSqliteMaintenanceRoots(
  targets: readonly SessionStoreTarget[],
  env: NodeJS.ProcessEnv,
): string[] {
  const stateDir = path.resolve(resolveStateDir(env));
  const roots = new Set([stateDir]);
  for (const target of targets) {
    const sqlitePath = resolveTargetSqlitePath(target);
    if (isPathWithin(stateDir, target.storePath) && isPathWithin(stateDir, sqlitePath)) {
      continue;
    }
    const commonRoot = commonPathAncestor(path.dirname(target.storePath), path.dirname(sqlitePath));
    const parentRoot = path.dirname(commonRoot);
    roots.add(parentRoot === path.parse(commonRoot).root ? commonRoot : parentRoot);
  }
  return [...roots];
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  return isPathInside(rootPath, path.resolve(candidatePath));
}

function commonPathAncestor(leftPath: string, rightPath: string): string {
  let currentPath = path.resolve(leftPath);
  const resolvedRightPath = path.resolve(rightPath);
  while (!isPathWithin(currentPath, resolvedRightPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return currentPath;
    }
    currentPath = parentPath;
  }
  return currentPath;
}
