/**
 * OpenViking Memory Plugin
 * 
 * @example
 * ```typescript
 * import openvikingPlugin from "@openclaw/memory-openviking";
 * 
 * // 在 OpenClaw 配置中使用
 * {
 *   plugins: {
 *     slots: { memory: "openviking" },
 *     entries: {
 *       openviking: {
 *         enabled: true,
 *         config: {
 *           baseUrl: "http://localhost:8080",
 *           tieredLoading: true
 *         }
 *       }
 *     }
 *   }
 * }
 * ```
 */

export { default } from "./index.js";
export * from "./index.js";
