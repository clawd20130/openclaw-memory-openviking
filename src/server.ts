/**
 * OpenViking 服务进程管理器
 * 用于自动启动/停止 OpenViking server
 */

import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import type { ServerConfig } from "./types.js";

export interface ServerManagerOptions {
  config: ServerConfig;
  logger?: {
    debug?: (msg: string) => void;
    info: (msg: string) => void;
    warn?: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export class OpenVikingServerManager {
  private config: ServerConfig;
  private logger: ServerManagerOptions["logger"];
  private process?: ChildProcess;
  private ready = false;
  private startupPromise?: Promise<void>;

  constructor(options: ServerManagerOptions) {
    this.config = {
      host: "127.0.0.1",
      port: 1933,
      startupTimeoutMs: 30000,
      ...options.config
    };
    this.logger = options.logger;
  }

  /**
   * 启动 OpenViking 服务
   */
  async start(): Promise<void> {
    if (this.ready) return;
    if (this.startupPromise) return this.startupPromise;

    this.startupPromise = this.doStart();
    return this.startupPromise;
  }

  private async doStart(): Promise<void> {
    const { venvPath, dataDir, host, port, startupTimeoutMs, env } = this.config;

    // 检查是否已有服务在运行
    try {
      const health = await this.checkHealth();
      if (health) {
        this.logger?.info(`OpenViking already running at ${host}:${port}`);
        this.ready = true;
        return;
      }
    } catch {
      // 未运行，继续启动
    }

    this.logger?.info(`Starting OpenViking server on ${host}:${port}...`);

    // 构建命令
    const pythonPath = path.join(venvPath, "bin", "python");
    const args = ["-m", "openviking", "serve", "--host", host!, "--port", String(port!)];

    if (dataDir) {
      args.push("--data-dir", dataDir);
    }

    // 环境变量
    const childEnv = {
      ...process.env,
      ...env,
      PYTHONUNBUFFERED: "1"
    };

    // 启动进程
    this.process = spawn(pythonPath, args, {
      env: childEnv,
      cwd: path.dirname(venvPath),
      detached: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    // 日志转发
    this.process.stdout?.on("data", (data) => {
      const line = data.toString().trim();
      if (line) this.logger?.debug?.(`[OpenViking] ${line}`);
    });

    this.process.stderr?.on("data", (data) => {
      const line = data.toString().trim();
      if (line) this.logger?.info(`[OpenViking] ${line}`);
    });

    // 进程退出处理
    this.process.on("exit", (code, signal) => {
      this.ready = false;
      if (code !== 0 && code !== null) {
        this.logger?.error(`OpenViking exited with code ${code}`);
      } else if (signal) {
        this.logger?.info(`OpenViking killed with signal ${signal}`);
      }
    });

    // 等待服务就绪
    await this.waitForReady(startupTimeoutMs!);
    this.ready = true;
    this.logger?.info("OpenViking server is ready");
  }

  /**
   * 等待服务就绪
   */
  private async waitForReady(timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 500;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const health = await this.checkHealth(2000);
        if (health) return;
      } catch {
        // 继续等待
      }
      await new Promise(r => setTimeout(r, checkInterval));
    }

    // 超时，杀掉进程
    this.kill();
    throw new Error(`OpenViking failed to start within ${timeoutMs}ms`);
  }

  /**
   * 健康检查
   */
  private async checkHealth(timeoutMs = 5000): Promise<boolean> {
    const { host, port } = this.config;
    const url = `http://${host}:${port}/health`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 停止服务
   */
  async stop(): Promise<void> {
    if (!this.process) return;

    this.logger?.info("Stopping OpenViking server...");

    return new Promise((resolve) => {
      const process = this.process!;

      // 优雅退出
      process.kill("SIGTERM");

      // 5秒后强制杀死
      const forceKillTimeout = setTimeout(() => {
        this.logger?.warn?.("Force killing OpenViking server...");
        process.kill("SIGKILL");
      }, 5000);

      process.on("exit", () => {
        clearTimeout(forceKillTimeout);
        this.ready = false;
        this.process = undefined;
        resolve();
      });
    });
  }

  /**
   * 强制杀死进程
   */
  private kill(): void {
    if (this.process) {
      this.process.kill("SIGKILL");
      this.process = undefined;
    }
    this.ready = false;
  }

  /**
   * 检查是否就绪
   */
  isReady(): boolean {
    return this.ready;
  }
}
