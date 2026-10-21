import { app, screen } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import log from "electron-log/main";
import {
  dockRuntimeRecordSchema,
  type DockObservation,
} from "./dock-runtime-protocol";
export type { DockObservation } from "./dock-runtime-protocol";

// Pixels stay in the helper. Only its bounded, validated numeric silhouette crosses
// this boundary. Unavailable geometry is never replaced by workArea or a Dock setting.
export class DockRuntime {
  status = "Stopped";
  private reason = "";
  get processingFrame() {
    return this.reason === "new_complete_pending";
  }
  private child: ChildProcessWithoutNullStreams | undefined;
  private closing: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private generation = 0;
  private stopping = false;
  // Keep the recovery budget across ordinary hide/show, suspend and diagnostic
  // ownership changes. Only an explicit Retry or sustained fresh callbacks reset it.
  private silenceRestarts = 0;
  private silenceRecoveryExhausted = false;
  constructor(
    private readonly changed: (observation: DockObservation | null) => void,
  ) {}

  resetRecoveryBudget() {
    this.silenceRestarts = 0;
    this.silenceRecoveryExhausted = false;
  }

  start() {
    this.active = true;
    if (this.silenceRecoveryExhausted) {
      this.status = "Dock capture unavailable; Retry Dock interaction";
      this.changed(null);
      return;
    }
    if (this.child) return;
    if (this.restartTimer) return;
    const directory = app.isPackaged
      ? path.join(process.resourcesPath, "native")
      : path.resolve(app.getAppPath(), "build/native");
    const child = spawn(path.join(directory, "dock-runtime"), [], {
      stdio: "pipe",
    });
    this.child = child;
    this.stopping = false;
    this.reason = "";
    this.status = "Checking Dock capture permission";
    this.changed(null);
    let receivedEnvironment = false;
    let failed = false;
    let startedAt = performance.now();
    let lastReceivedAt = startedAt;
    let elapsed = -1;
    let sequence = 0;
    let buffer = "";
    let stderrBytes = 0;
    let permissionBlocked = false;
    let silentSince: number | undefined;
    let freshSince: number | undefined;
    let freshUntil: number | undefined;
    const decoder = new StringDecoder("utf8");
    const primary = screen.getPrimaryDisplay();
    const signature = () => {
      const display = screen.getPrimaryDisplay();
      return JSON.stringify([display.id, display.bounds, display.scaleFactor]);
    };
    const initialDisplay = signature();
    const fail = (reason: string) => {
      if (failed) return;
      failed = true;
      this.reason = "";
      this.status = reason;
      this.changed(null);
      log.warn("Dock runtime unavailable", { reason });
      child.kill("SIGTERM");
      this.killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1500);
    };
    child.stdout.on("data", (data: Buffer) => {
      if (failed || !this.active || this.stopping) return;
      try {
        buffer += decoder.write(data);
        if (Buffer.byteLength(buffer) > 1024 * 1024)
          throw new Error("Dock output exceeded receive limit");
        let end: number;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (Buffer.byteLength(line) > 512 * 1024)
            throw new Error("Dock output exceeded record limit");
          const record = dockRuntimeRecordSchema.parse(JSON.parse(line));
          if (record.type === "environment") {
            if (
              receivedEnvironment ||
              record.processID !== child.pid ||
              record.parentPID !== process.pid
            )
              throw new Error("Dock helper identity mismatch");
            receivedEnvironment = true;
            startedAt = performance.now();
            lastReceivedAt = startedAt;
            continue;
          }
          if (!receivedEnvironment) throw new Error("Dock environment missing");
          const now = performance.now();
          if (
            record.elapsed <= elapsed ||
            record.sequence < sequence ||
            (now - startedAt) / 1000 - record.elapsed > 1 ||
            record.elapsed - (now - startedAt) / 1000 > 1
          )
            throw new Error("Dock output is stale or out of order");
          elapsed = record.elapsed;
          sequence = record.sequence;
          lastReceivedAt = now;
          const observation = record.observation;
          const addedTransportAge = Math.max(
            0,
            (now - startedAt) / 1000 - record.elapsed,
          );
          if (observation) {
            const area = primary.bounds;
            const b = observation.bounds;
            const bottom = observation.orientation === "bottom";
            if (
              signature() !== initialDisplay ||
              observation.primaryDisplayID !== primary.id ||
              b.x < area.x - 1 ||
              b.y < area.y - 1 ||
              b.x + b.width > area.x + area.width + 1 ||
              b.y + b.height > area.y + area.height + 1 ||
              record.callbackAgeSeconds === null ||
              record.callbackAgeSeconds + addedTransportAge > 0.75 ||
              record.sourceAgeSeconds === null ||
              (!record.idle && record.sourceAgeSeconds + addedTransportAge > 1)
            )
              throw new Error(
                "Dock observation mapping or freshness is invalid",
              );
            let previousAxis = -Infinity;
            for (const point of observation.contour) {
              if (
                point.axis <= previousAxis ||
                point.axis < (bottom ? b.x : b.y) - 1 ||
                point.axis > (bottom ? b.x + b.width : b.y + b.height) + 1 ||
                point.inward < (bottom ? b.y : b.x) - 1 ||
                point.inward > (bottom ? b.y + b.height : b.x + b.width) + 1
              )
                throw new Error("Dock contour exceeds its visible bounds");
              previousAxis = point.axis;
            }
          }
          this.reason = record.reason;
          permissionBlocked =
            record.reason === "permission_unavailable" ||
            record.reason === "permission_lost";
          if (record.reason === "callback_silence") {
            silentSince ??= now;
            freshSince = undefined;
            freshUntil = undefined;
          } else {
            silentSince = undefined;
            if (
              !permissionBlocked &&
              record.callbackAgeSeconds !== null &&
              record.callbackAgeSeconds + addedTransportAge <= 0.75
            ) {
              // A sparse report cannot cover an unseen gap beyond the previous
              // callback's freshness deadline, even when each report is fresh.
              if (freshUntil === undefined || now > freshUntil)
                freshSince = now;
              freshUntil =
                now +
                (0.75 - record.callbackAgeSeconds - addedTransportAge) * 1000;
              if (freshSince !== undefined && now - freshSince >= 5000)
                this.silenceRestarts = 0;
            } else {
              freshSince = undefined;
              freshUntil = undefined;
            }
          }
          this.status = observation
            ? "Dock interaction active"
            : permissionBlocked
              ? "Dock interaction needs Screen Recording permission"
              : record.reason === "new_complete_pending"
                ? "Updating Dock edge"
                : [
                      "alpha_empty",
                      "callback_silence",
                      "incomplete_frame",
                      "waiting_for_complete_frame",
                    ].includes(record.reason)
                  ? "Dock interaction waiting for visible Dock"
                  : "Dock interaction unavailable";
          this.changed(observation);
        }
      } catch {
        fail("Dock protocol invalid or stale");
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes > 32768) fail("Dock stderr exceeded limit");
    });
    child.once("error", () => fail("Dock helper could not start"));
    this.closing = new Promise<void>((resolve) =>
      child.once("close", () => {
        clearInterval(this.timer);
        clearTimeout(this.killTimer);
        this.timer = undefined;
        this.killTimer = undefined;
        this.child = undefined;
        this.closing = undefined;
        if (!failed && this.active && buffer.length !== 0)
          this.status = "Dock output truncated";
        else if (
          !failed &&
          this.active &&
          this.status === "Dock interaction active"
        )
          this.status = "Dock capture ended";
        this.reason = "";
        this.changed(null);
        resolve();
        if (
          this.active &&
          !this.silenceRecoveryExhausted &&
          (!permissionBlocked || this.stopping)
        ) {
          const generation = this.generation;
          this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            if (this.active && generation === this.generation) this.start();
          }, 1000);
        }
      }),
    );
    this.timer = setInterval(() => {
      if (!this.active || failed || this.stopping) return;
      if (signature() !== initialDisplay) {
        fail("Dock display changed");
      } else if (
        performance.now() - lastReceivedAt >
        (receivedEnvironment ? 1500 : 10000)
      )
        fail("Dock capture heartbeat unavailable");
      else if (
        silentSince !== undefined &&
        performance.now() - silentSince >= 5000
      ) {
        if (this.silenceRestarts < 3) {
          this.silenceRestarts += 1;
          fail("Dock capture callbacks unavailable; restarting");
        } else {
          this.silenceRecoveryExhausted = true;
          fail("Dock capture unavailable; Retry Dock interaction");
        }
      }
    }, 250);
  }

  async stop() {
    this.active = false;
    this.generation += 1;
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const child = this.child;
    this.reason = "";
    this.status = child ? "Stopping Dock capture" : "Stopped";
    this.changed(null);
    if (!child) return;
    child.kill("SIGTERM");
    this.killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1500);
    await this.closing;
    if (!this.active) {
      this.status = "Stopped";
      this.changed(null);
    }
  }
}
