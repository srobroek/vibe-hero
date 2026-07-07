/**
 * @file Structured diagnostic logging (pino).
 *
 * vibe-hero runs as a stdio MCP server: stdout carries the JSON-RPC stream the
 * host reads, so logs MUST go to STDERR only — anything on stdout corrupts the
 * protocol. This module wraps {@link https://github.com/pinojs/pino | pino} with
 * a stderr destination and an env-controlled level, exposing a tiny
 * {@link debug}/{@link logger} surface the rest of the server uses.
 *
 * ## Enabling logs
 *
 * Logging is OFF by default (level `silent`). Control it with env vars:
 *
 * - `VIBE_HERO_DEBUG=1` (or `true`/`yes`) → level `debug`.
 * - `VIBE_HERO_DEBUG=/path/to/file.log` → level `debug` AND tee every line to
 *   that file (the only way to capture logs when a host swallows stderr).
 * - `VIBE_HERO_LOG_LEVEL=trace|debug|info|warn|error|fatal|silent` → set the
 *   level explicitly (takes precedence over `VIBE_HERO_DEBUG`'s implied level).
 *
 * Output is newline-delimited JSON (one object per line) with a timestamp,
 * level, and any structured fields passed in — parseable with `jq`, unlike
 * ad-hoc `console.error` prints.
 */
import pino, { type Logger } from "pino";

const RAW_DEBUG = process.env["VIBE_HERO_DEBUG"];
const DEBUG_ON =
  RAW_DEBUG !== undefined &&
  RAW_DEBUG !== "" &&
  RAW_DEBUG !== "0" &&
  RAW_DEBUG !== "false";

/** A file sink when VIBE_HERO_DEBUG points at a path, else undefined. */
const FILE =
  DEBUG_ON && RAW_DEBUG !== undefined && (RAW_DEBUG.includes("/") || RAW_DEBUG.endsWith(".log"))
    ? RAW_DEBUG
    : undefined;

/** Is stage-timing profiling on (`VIBE_HERO_PROFILE`)? Enables `info` level. */
const RAW_PROFILE = process.env["VIBE_HERO_PROFILE"];
const PROFILE_ON =
  RAW_PROFILE !== undefined &&
  RAW_PROFILE !== "" &&
  RAW_PROFILE !== "0" &&
  RAW_PROFILE !== "false";

/** Resolve the effective level: explicit env wins, else debug, else profile, else silent. */
const level =
  process.env["VIBE_HERO_LOG_LEVEL"] ??
  (DEBUG_ON ? "debug" : PROFILE_ON ? "info" : "silent");

// Destination: stderr (fd 2) so stdout stays a clean JSON-RPC channel. When a
// file path is configured we tee to BOTH stderr and the file via pino.multistream.
const buildLogger = (): Logger => {
  const base = { name: "vibe-hero", level };
  if (FILE !== undefined) {
    const streams = [
      { stream: pino.destination({ fd: 2, sync: true }) },
      { stream: pino.destination({ dest: FILE, sync: true, mkdir: true }) },
    ];
    return pino(base, pino.multistream(streams));
  }
  return pino(base, pino.destination({ fd: 2, sync: true }));
};

/** The shared structured logger. Writes NDJSON to stderr (never stdout). */
export const logger: Logger = buildLogger();

/** Is diagnostic logging on? Cheap guard so callers can skip building payloads. */
export const debugEnabled = (): boolean => level !== "silent";

/**
 * Emit one debug-level event. No-op (pino-gated) unless logging is enabled.
 *
 * @param msg - Short event description.
 * @param data - Optional structured fields, logged as JSON properties.
 */
export const debug = (msg: string, data?: unknown): void => {
  if (data !== undefined) logger.debug(data as object, msg);
  else logger.debug(msg);
};
