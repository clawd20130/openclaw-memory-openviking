/**
 * OpenViking Memory Manager
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { OpenVikingClient, OpenVikingHttpError } from "./client.js";
import { PathMapper } from "./mapper.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate
} from "./memory.js";
import type { OpenVikingMatchedContext, OpenVikingPluginConfig } from "./types.js";

export interface OpenVikingMemoryManagerOptions {
  config: OpenVikingPluginConfig;
  workspaceDir: string;
  agentId: string;
  logger?: {
    debug?: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

interface LocalSyncFile {
  relPath: string;
  fullPath: string;
  desiredRootUri: string;
  targetParentUri: string;
  fingerprint: string;
}

interface SyncedFileSnapshot {
  fingerprint: string;
  uri: string;
}

interface PersistedSyncStateEntry {
  relPath: string;
  fingerprint: string;
  uri: string;
}

interface PersistedSyncState {
  version: number;
  agentId: string;
  entries: PersistedSyncStateEntry[];
  ovConfigPath?: string;
  ovConfigFingerprint?: string;
  lastRunStatus?: PersistedSyncLastRunStatus;
  lastRunReason?: string;
  lastRunStartedAt?: string;
  lastRunCompletedAt?: string;
}

interface OvConfigState {
  path?: string;
  fingerprint?: string;
}

type PersistedSyncLastRunStatus = "running" | "success" | "failed";

export class OpenVikingMemoryManager implements MemorySearchManager {
  private readonly client: OpenVikingClient;
  private readonly mapper: PathMapper;
  private readonly config: OpenVikingPluginConfig;
  private readonly workspaceDir: string;
  private readonly agentId: string;
  private readonly logger?: OpenVikingMemoryManagerOptions["logger"];
  private readonly snapshotFilePath: string;
  private closed = false;
  private lastSyncAt?: Date;
  private readonly syncedSnapshot = new Map<string, SyncedFileSnapshot>();
  private snapshotLoaded = false;
  private snapshotOvConfigPath?: string;
  private snapshotOvConfigFingerprint?: string;
  private snapshotLastRunStatus: PersistedSyncLastRunStatus = "success";
  private snapshotLastRunReason?: string;
  private snapshotLastRunStartedAt?: string;
  private snapshotLastRunCompletedAt?: string;
  private snapshotRecoveryNeeded = false;

  constructor(options: OpenVikingMemoryManagerOptions) {
    this.config = options.config;
    this.workspaceDir = options.workspaceDir;
    this.agentId = options.agentId;
    this.logger = options.logger;
    this.snapshotFilePath = this.resolveSnapshotFilePath(options.agentId);
    this.client = new OpenVikingClient({
      baseUrl: options.config.baseUrl,
      apiKey: options.config.apiKey,
      timeoutMs: 30000
    });
    this.mapper = new PathMapper({
      mappings: options.config.mappings,
      uriBase: options.config.uriBase,
      agentId: options.agentId
    });
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string }
  ): Promise<MemorySearchResult[]> {
    this.ensureOpen();
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }

    const limit = Math.max(1, opts?.maxResults ?? this.config.search?.defaultLimit ?? 6);
    const threshold = opts?.minScore ?? this.config.search?.scoreThreshold ?? 0;
    const mode = this.config.search?.mode ?? "find";
    const targetUri = this.config.search?.targetUri ?? this.mapper.getRootPrefix();

    this.logger?.debug?.(
      `openviking search mode=${mode}, query="${cleaned}", target=${targetUri}, limit=${limit}`
    );

    const result =
      mode === "search"
        ? await this.client.search({
            query: cleaned,
            limit,
            score_threshold: threshold,
            target_uri: targetUri,
            session_id: opts?.sessionKey
          })
        : await this.client.find({
            query: cleaned,
            limit,
            score_threshold: threshold,
            target_uri: targetUri
          });

    const rows: OpenVikingMatchedContext[] = [
      ...(result.memories ?? []),
      ...(result.resources ?? []),
      ...(result.skills ?? [])
    ];

    return rows
      .map((entry) => this.toMemorySearchResult(entry))
      .filter((entry) => entry.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    this.ensureOpen();
    const relPath = this.ensureSafeRelPath(params.relPath);
    const rootUri = this.mapper.toVikingUri(relPath);
    const contentUri = this.mapper.toContentUri(relPath);

    this.logger?.debug?.(
      `openviking read relPath=${relPath}, rootUri=${rootUri}, contentUri=${contentUri}`
    );

    try {
      let text = "";
      const requiresExactLines = params.from !== undefined || params.lines !== undefined;

      if (requiresExactLines || this.config.tieredLoading === false) {
        text = await this.client.read(contentUri);
      } else {
        try {
          text = await this.client.overview(rootUri);
        } catch {
          text = await this.client.read(contentUri);
        }
      }

      return {
        path: relPath,
        text: this.sliceLines(text, params.from, params.lines)
      };
    } catch (error) {
      this.logger?.warn(`OpenViking read failed for ${relPath}, fallback to local file: ${error}`);
      return await this.readLocalFile({
        relPath,
        from: params.from,
        lines: params.lines
      });
    }
  }

  status(): MemoryProviderStatus {
    return {
      backend: "builtin",
      provider: "openviking",
      model: this.config.search?.mode ?? "find",
      workspaceDir: this.workspaceDir,
      custom: {
        baseUrl: this.config.baseUrl,
        agentId: this.agentId,
        rootPrefix: this.mapper.getRootPrefix(),
        tieredLoading: this.config.tieredLoading !== false,
        lastSyncAt: this.lastSyncAt?.toISOString()
      }
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    this.ensureOpen();
    await this.ensureSnapshotLoaded();

    const syncReason = params?.reason ?? "manual";
    const recoveryRequired = this.snapshotRecoveryNeeded;
    if (recoveryRequired) {
      this.logger?.warn(
        "openviking detected interrupted/failed previous sync, force a full recovery sync"
      );
    }

    this.snapshotRecoveryNeeded = false;
    this.snapshotLastRunStatus = "running";
    this.snapshotLastRunReason = syncReason;
    this.snapshotLastRunStartedAt = new Date().toISOString();
    this.snapshotLastRunCompletedAt = undefined;
    await this.persistSnapshot().catch((error) => {
      this.logger?.warn(`Failed to mark sync as running: ${String(error)}`);
    });

    let syncCompletedSuccessfully = false;

    try {
      const ovConfigState = await this.readOvConfigState();
      const ovConfigChanged = this.hasOvConfigChanged(ovConfigState);
      if (ovConfigChanged) {
        this.logger?.info(
          `openviking ov.conf changed, trigger full sync: path=${ovConfigState.path ?? "n/a"}`
        );
      }
      const forceFullSync = params?.force === true || ovConfigChanged || recoveryRequired;

      const localFiles = await this.collectLocalSyncFiles();
      const localByPath = new Map(localFiles.map((file) => [file.relPath, file]));
      const staleEntries = [...this.syncedSnapshot.entries()].filter(
        ([relPath]) => !localByPath.has(relPath)
      );
      const filesToSync = forceFullSync
        ? localFiles
        : localFiles.filter((file) => {
            const previous = this.syncedSnapshot.get(file.relPath);
            if (!previous) {
              return true;
            }
            if (previous.fingerprint !== file.fingerprint) {
              return true;
            }
            return this.normalizeUri(previous.uri) !== this.normalizeUri(file.desiredRootUri);
          });
      const total = filesToSync.length + staleEntries.length;
      let completed = 0;
      let syncedCount = 0;
      let removedCount = 0;
      const skippedCount = localFiles.length - filesToSync.length;
      let syncHadErrors = false;
      this.snapshotOvConfigPath = ovConfigState.path;
      this.snapshotOvConfigFingerprint = ovConfigState.fingerprint;

      this.logger?.info(
        `openviking sync started: reason=${syncReason}, force=${forceFullSync}, scanned=${localFiles.length}, upsert=${filesToSync.length}, delete=${staleEntries.length}, skipped=${skippedCount}`
      );
      params?.progress?.({ completed, total, label: "Scanning memory files..." });

      for (const file of filesToSync) {
        try {
          const previous = this.syncedSnapshot.get(file.relPath);
          const previousUri =
            previous && this.normalizeUri(previous.uri) !== this.normalizeUri(file.desiredRootUri)
              ? previous.uri
              : undefined;
          await this.syncFile(file);
          if (previousUri) {
            await this.tryRemove(previousUri).catch((error) => {
              this.logger?.warn(
                `Failed to remove previous mapped uri for ${file.relPath}: ${String(error)}`
              );
            });
          }
          this.syncedSnapshot.set(file.relPath, {
            fingerprint: file.fingerprint,
            uri: file.desiredRootUri
          });
          syncedCount += 1;
        } catch (error) {
          syncHadErrors = true;
          this.logger?.error(`Failed to sync ${file.relPath}: ${String(error)}`);
        } finally {
          completed += 1;
          params?.progress?.({
            completed,
            total,
            label: `Syncing ${path.basename(file.relPath)}`
          });
        }
      }

      for (const [relPath, snapshot] of staleEntries) {
        try {
          await this.tryRemove(snapshot.uri);
          this.syncedSnapshot.delete(relPath);
          removedCount += 1;
        } catch (error) {
          syncHadErrors = true;
          this.logger?.error(`Failed to remove stale remote memory for ${relPath}: ${String(error)}`);
        } finally {
          completed += 1;
          params?.progress?.({
            completed,
            total,
            label: `Removing ${path.basename(relPath)}`
          });
        }
      }

      if (this.config.sync?.waitForProcessing) {
        const timeout = this.config.sync.waitTimeoutSec;
        try {
          await this.client.waitProcessed(timeout);
        } catch (error) {
          syncHadErrors = true;
          this.logger?.error(`Failed to wait OpenViking processing queues: ${String(error)}`);
        }
      }

      this.lastSyncAt = new Date();
      params?.progress?.({ completed: total, total, label: "Sync completed" });
      this.logger?.info(
        `openviking sync finished: scanned=${localFiles.length}, synced=${syncedCount}, removed=${removedCount}, skipped=${skippedCount}`
      );

      if (syncHadErrors) {
        this.logger?.warn("openviking sync finished with errors; next sync will force recovery");
      }
      syncCompletedSuccessfully = !syncHadErrors;
    } catch (error) {
      this.logger?.error(`openviking sync aborted: ${String(error)}`);
      throw error;
    } finally {
      this.snapshotLastRunStatus = syncCompletedSuccessfully ? "success" : "failed";
      this.snapshotLastRunCompletedAt = new Date().toISOString();
      this.snapshotRecoveryNeeded = !syncCompletedSuccessfully;

      await this.persistSnapshot().catch((error) => {
        this.logger?.warn(`Failed to persist sync snapshot: ${String(error)}`);
      });
    }
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      const health = await this.client.health();
      if (health.status !== "ok") {
        return { ok: false, error: `health=${health.status}` };
      }
      const system = await this.client.systemStatus();
      if (!system.initialized) {
        return { ok: false, error: "OpenViking is not initialized" };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    try {
      const system = await this.client.systemStatus();
      return Boolean(system.initialized);
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.logger?.info("openviking manager closed");
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("OpenVikingMemoryManager is closed");
    }
  }

  private toMemorySearchResult(entry: OpenVikingMatchedContext): MemorySearchResult {
    const pathHint = this.mapper.fromVikingUri(entry.uri);
    const snippet = (entry.abstract?.trim() || entry.match_reason?.trim() || entry.uri).slice(0, 1200);
    return {
      path: pathHint,
      startLine: 1,
      endLine: 1,
      score: Number.isFinite(entry.score) ? entry.score : 0,
      snippet,
      source: this.inferSource(entry.uri, entry.context_type),
      citation: `${pathHint}#L1`
    };
  }

  private inferSource(uri: string, contextType: string): MemorySource {
    if (uri.includes("viking://session/")) {
      return "sessions";
    }
    if (contextType === "memory") {
      return "memory";
    }
    return "memory";
  }

  private async readLocalFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const fullPath = path.join(this.workspaceDir, params.relPath);
    const content = await fs.readFile(fullPath, "utf-8");
    return {
      path: params.relPath,
      text: this.sliceLines(content, params.from, params.lines)
    };
  }

  private sliceLines(content: string, from?: number, lines?: number): string {
    if (from === undefined && lines === undefined) {
      return content;
    }
    const allLines = content.split("\n");
    const start = Math.max(0, (from ?? 1) - 1);
    const end =
      lines === undefined ? allLines.length : Math.max(start, Math.min(allLines.length, start + lines));
    return allLines.slice(start, end).join("\n");
  }

  private ensureSafeRelPath(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error("path required");
    }
    const normalized = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
    const safe = path.posix.normalize(normalized);
    if (safe.startsWith("../") || safe.includes("/../") || safe === "..") {
      throw new Error(`invalid path: ${input}`);
    }
    return safe;
  }

  private async scanFiles(): Promise<string[]> {
    const files = new Set<string>();

    const addIfExists = async (relPath: string): Promise<void> => {
      try {
        await fs.access(path.join(this.workspaceDir, relPath));
        files.add(relPath);
      } catch {
        // ignore missing file
      }
    };

    // 根目录关键记忆文件
    const rootFiles = [
      "MEMORY.md",
      "memory.md",
      "SOUL.md",
      "USER.md",
      "AGENTS.md",
      "TOOLS.md",
      "IDENTITY.md",
      "BOOTSTRAP.md"
    ];
    for (const relPath of rootFiles) {
      await addIfExists(relPath);
    }

    // memory/*.md
    const memoryDir = path.join(this.workspaceDir, "memory");
    try {
      const entries = await fs.readdir(memoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.add(`memory/${entry.name}`);
        }
      }
    } catch {
      // ignore missing directory
    }

    // skills/*/SKILL.md
    const skillsDir = path.join(this.workspaceDir, "skills");
    try {
      const skillDirs = await fs.readdir(skillsDir, { withFileTypes: true });
      for (const entry of skillDirs) {
        if (!entry.isDirectory()) {
          continue;
        }
        const skillPath = path.join("skills", entry.name, "SKILL.md").replace(/\\/g, "/");
        await addIfExists(skillPath);
      }
    } catch {
      // ignore missing directory
    }

    // 额外配置路径
    for (const extraPath of this.config.sync?.extraPaths ?? []) {
      await this.scanExtraPath(extraPath, files);
    }

    return [...files].sort((a, b) => a.localeCompare(b));
  }

  private async collectLocalSyncFiles(): Promise<LocalSyncFile[]> {
    const relPaths = await this.scanFiles();
    const files: LocalSyncFile[] = [];
    for (const relPath of relPaths) {
      const safeRelPath = this.ensureSafeRelPath(relPath);
      const fullPath = path.join(this.workspaceDir, safeRelPath);
      const stat = await fs.stat(fullPath);
      files.push({
        relPath: safeRelPath,
        fullPath,
        desiredRootUri: this.mapper.toVikingUri(safeRelPath),
        targetParentUri: this.mapper.toTargetParentUri(safeRelPath),
        fingerprint: this.toFileFingerprint(stat.size, stat.mtimeMs)
      });
    }
    return files;
  }

  private async scanExtraPath(rawPath: string, files: Set<string>): Promise<void> {
    const relPath = this.resolveExtraPath(rawPath);
    if (!relPath) {
      return;
    }

    const absPath = relPath === "." ? this.workspaceDir : path.join(this.workspaceDir, relPath);
    try {
      const stat = await fs.lstat(absPath);
      if (stat.isSymbolicLink()) {
        this.logger?.warn(`Skip symlink extra path: ${rawPath}`);
        return;
      }
      if (stat.isDirectory()) {
        await this.collectMarkdownFiles(absPath, files);
        return;
      }
      if (stat.isFile()) {
        if (absPath.toLowerCase().endsWith(".md")) {
          files.add(relPath);
        } else {
          this.logger?.warn(`Skip non-markdown extra file: ${rawPath}`);
        }
        return;
      }
      this.logger?.warn(`Skip unsupported extra path type: ${rawPath}`);
    } catch (error) {
      this.logger?.warn(`Skip missing/inaccessible extra path ${rawPath}: ${String(error)}`);
    }
  }

  private resolveExtraPath(rawPath: string): string | null {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      return null;
    }

    const absPath = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(this.workspaceDir, trimmed);
    const relPath = path.relative(this.workspaceDir, absPath);
    if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
      this.logger?.warn(`Skip extra path outside workspace: ${trimmed}`);
      return null;
    }
    const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    return normalized || ".";
  }

  private async collectMarkdownFiles(dir: string, files: Set<string>): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await this.collectMarkdownFiles(entryPath, files);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      const relPath = path.relative(this.workspaceDir, entryPath);
      if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
        continue;
      }
      files.add(relPath.replace(/\\/g, "/"));
    }
  }

  private toFileFingerprint(size: number, mtimeMs: number): string {
    return `${size}:${Math.trunc(mtimeMs)}`;
  }

  private resolveExplicitOvConfigPath(): string | undefined {
    const configuredPath = this.config.sync?.ovConfigPath?.trim();
    if (configuredPath) {
      return path.isAbsolute(configuredPath)
        ? path.resolve(configuredPath)
        : path.resolve(this.workspaceDir, configuredPath);
    }

    const serverDataDir = this.config.server?.dataDir?.trim();
    if (!serverDataDir) {
      return undefined;
    }

    if (path.isAbsolute(serverDataDir)) {
      return path.join(serverDataDir, "ov.conf");
    }

    const serverCwd = path.dirname(this.config.server?.venvPath ?? this.workspaceDir);
    return path.join(path.resolve(serverCwd, serverDataDir), "ov.conf");
  }

  private resolveAutoOvConfigCandidates(): string[] {
    const homeDir = process.env.HOME;
    const candidates = [
      path.join(this.workspaceDir, "ov.conf"),
      homeDir ? path.join(homeDir, "openviking", "ov.conf") : "",
      homeDir ? path.join(homeDir, ".openviking", "ov.conf") : ""
    ].filter(Boolean);
    return [...new Set(candidates)];
  }

  private async readOvConfigFingerprint(filePath: string): Promise<string | undefined> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return createHash("sha256").update(content).digest("hex");
    } catch (error) {
      if (!this.isFsNotFoundError(error)) {
        this.logger?.warn(`Failed to read ov.conf: ${filePath}: ${String(error)}`);
      }
      return undefined;
    }
  }

  private async readOvConfigState(): Promise<OvConfigState> {
    const explicitPath = this.resolveExplicitOvConfigPath();
    if (explicitPath) {
      return {
        path: explicitPath,
        fingerprint: await this.readOvConfigFingerprint(explicitPath)
      };
    }

    for (const candidate of this.resolveAutoOvConfigCandidates()) {
      const fingerprint = await this.readOvConfigFingerprint(candidate);
      if (fingerprint) {
        return {
          path: candidate,
          fingerprint
        };
      }
    }

    return {};
  }

  private hasOvConfigChanged(current: OvConfigState): boolean {
    if (!current.path && !this.snapshotOvConfigPath) {
      return false;
    }
    if (current.path !== this.snapshotOvConfigPath) {
      return true;
    }
    return current.fingerprint !== this.snapshotOvConfigFingerprint;
  }

  private resolveSnapshotFilePath(agentId: string): string {
    const safeAgentId = agentId.replace(/[^a-zA-Z0-9_.-]/g, "_") || "main";
    return path.join(
      this.workspaceDir,
      ".openclaw",
      "plugins",
      "openviking-memory",
      `${safeAgentId}.sync-state.json`
    );
  }

  private async ensureSnapshotLoaded(): Promise<void> {
    if (this.snapshotLoaded) {
      return;
    }
    this.snapshotLoaded = true;

    let raw = "";
    try {
      raw = await fs.readFile(this.snapshotFilePath, "utf-8");
    } catch (error) {
      if (this.isFsNotFoundError(error)) {
        return;
      }
      this.logger?.warn(`Failed to read sync snapshot: ${String(error)}`);
      return;
    }

    try {
      const parsed = JSON.parse(raw) as PersistedSyncState;
      if (
        (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) ||
        typeof parsed.agentId !== "string" ||
        !Array.isArray(parsed.entries)
      ) {
        this.logger?.warn("Ignore sync snapshot with unsupported schema version");
        return;
      }

      this.syncedSnapshot.clear();
      for (const entry of parsed.entries) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        if (
          typeof entry.relPath !== "string" ||
          typeof entry.fingerprint !== "string" ||
          typeof entry.uri !== "string"
        ) {
          continue;
        }
        let safeRelPath = "";
        try {
          safeRelPath = this.ensureSafeRelPath(entry.relPath);
        } catch {
          continue;
        }
        this.syncedSnapshot.set(safeRelPath, {
          fingerprint: entry.fingerprint,
          uri: entry.uri
        });
      }
      this.snapshotOvConfigPath =
        typeof parsed.ovConfigPath === "string" ? parsed.ovConfigPath : undefined;
      this.snapshotOvConfigFingerprint =
        typeof parsed.ovConfigFingerprint === "string" ? parsed.ovConfigFingerprint : undefined;
      this.snapshotLastRunStatus =
        parsed.lastRunStatus === "running" ||
        parsed.lastRunStatus === "success" ||
        parsed.lastRunStatus === "failed"
          ? parsed.lastRunStatus
          : "success";
      this.snapshotLastRunReason =
        typeof parsed.lastRunReason === "string" ? parsed.lastRunReason : undefined;
      this.snapshotLastRunStartedAt =
        typeof parsed.lastRunStartedAt === "string" ? parsed.lastRunStartedAt : undefined;
      this.snapshotLastRunCompletedAt =
        typeof parsed.lastRunCompletedAt === "string" ? parsed.lastRunCompletedAt : undefined;
      this.snapshotRecoveryNeeded =
        this.snapshotLastRunStatus === "running" || this.snapshotLastRunStatus === "failed";
      this.logger?.info(
        `openviking sync snapshot loaded: entries=${this.syncedSnapshot.size}, file=${this.snapshotFilePath}`
      );
    } catch (error) {
      this.logger?.warn(`Failed to parse sync snapshot: ${String(error)}`);
    }
  }

  private async persistSnapshot(): Promise<void> {
    const entries: PersistedSyncStateEntry[] = [...this.syncedSnapshot.entries()]
      .map(([relPath, snapshot]) => ({
        relPath,
        fingerprint: snapshot.fingerprint,
        uri: snapshot.uri
      }))
      .sort((a, b) => a.relPath.localeCompare(b.relPath));

    const payload: PersistedSyncState = {
      version: 3,
      agentId: this.agentId,
      entries,
      ovConfigPath: this.snapshotOvConfigPath,
      ovConfigFingerprint: this.snapshotOvConfigFingerprint,
      lastRunStatus: this.snapshotLastRunStatus,
      lastRunReason: this.snapshotLastRunReason,
      lastRunStartedAt: this.snapshotLastRunStartedAt,
      lastRunCompletedAt: this.snapshotLastRunCompletedAt
    };

    const targetDir = path.dirname(this.snapshotFilePath);
    await fs.mkdir(targetDir, { recursive: true });
    const tmpPath = `${this.snapshotFilePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    await fs.rename(tmpPath, this.snapshotFilePath);
  }

  private isFsNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }
    const code = (error as { code?: unknown }).code;
    return code === "ENOENT";
  }

  private async syncFile(file: LocalSyncFile): Promise<void> {
    const safeRelPath = file.relPath;
    const fullPath = file.fullPath;
    const desiredRootUri = file.desiredRootUri;
    const targetParentUri = file.targetParentUri;

    this.logger?.debug?.(
      `openviking sync file relPath=${safeRelPath}, parent=${targetParentUri}, target=${desiredRootUri}`
    );

    await this.ensureTargetParent(targetParentUri);
    await this.tryRemove(desiredRootUri);

    const importResult = await this.client.addResource({
      path: fullPath,
      target: targetParentUri,
      reason: `OpenClaw memory sync: ${safeRelPath}`,
      wait: false
    });

    const importedRoot = importResult.root_uri;
    if (!importedRoot) {
      throw new Error(`OpenViking import result missing root_uri: ${safeRelPath}`);
    }

    if (this.normalizeUri(importedRoot) !== this.normalizeUri(desiredRootUri)) {
      this.logger?.warn(
        `openviking import root mismatch for ${safeRelPath}: imported=${importedRoot}, expected=${desiredRootUri}; move to expected path`
      );
      await this.tryRemove(desiredRootUri);
      await this.client.move(importedRoot, desiredRootUri);
    }
  }

  private async ensureTargetParent(uri: string): Promise<void> {
    if (await this.pathExists(uri)) {
      this.logger?.debug?.(`openviking mkdir skipped (already exists): ${uri}`);
      return;
    }

    try {
      await this.client.mkdir(uri);
    } catch (error) {
      if (this.shouldIgnoreExistingPathError(error)) {
        this.logger?.debug?.(`openviking mkdir skipped (already exists): ${uri}`);
        return;
      }
      throw error;
    }
  }

  private async tryRemove(uri: string): Promise<void> {
    if (!(await this.pathExists(uri))) {
      this.logger?.debug?.(`openviking remove skipped (missing path): ${uri}`);
      return;
    }

    try {
      await this.client.remove(uri, true);
    } catch (error) {
      if (this.shouldIgnoreMissingPathError(error)) {
        this.logger?.debug?.(`openviking remove skipped (missing path): ${uri}`);
        return;
      }
      throw error;
    }
  }

  private async pathExists(uri: string): Promise<boolean> {
    try {
      await this.client.stat(uri);
      return true;
    } catch (error) {
      if (this.shouldIgnoreMissingPathError(error)) {
        return false;
      }
      throw error;
    }
  }

  private normalizeUri(uri: string): string {
    return uri.replace(/\/+$/, "");
  }

  private shouldIgnoreMissingPathError(error: unknown): boolean {
    if (error instanceof OpenVikingHttpError) {
      if (error.status === 404) {
        return true;
      }
      if (typeof error.code === "string" && /not[_-]?found/i.test(error.code)) {
        return true;
      }
      const message = [
        error.message,
        error.details ? JSON.stringify(error.details) : ""
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return this.looksLikeMissingPath(message);
    }

    if (error instanceof Error) {
      return this.looksLikeMissingPath(error.message.toLowerCase());
    }
    return false;
  }

  private shouldIgnoreExistingPathError(error: unknown): boolean {
    if (error instanceof OpenVikingHttpError) {
      if (error.status === 409) {
        return true;
      }
      if (typeof error.code === "string" && /already[_-]?exists/i.test(error.code)) {
        return true;
      }
      const message = [
        error.message,
        error.details ? JSON.stringify(error.details) : ""
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return this.looksLikeExistingPath(message);
    }

    if (error instanceof Error) {
      return this.looksLikeExistingPath(error.message.toLowerCase());
    }
    return false;
  }

  private looksLikeMissingPath(text: string): boolean {
    return (
      text.includes("no such file or directory") ||
      text.includes("no such directory") ||
      text.includes("not found") ||
      text.includes("path not found")
    );
  }

  private looksLikeExistingPath(text: string): boolean {
    return (
      text.includes("already exists") ||
      text.includes("file exists") ||
      text.includes("directory exists")
    );
  }
}
