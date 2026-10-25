import {
  app,
  BrowserWindow,
  powerMonitor,
  screen,
  systemPreferences,
  type MenuItemConstructorOptions,
} from "electron";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { dockRecordSchema, helperReceiptSchema } from "./dock-protocol";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINE = 64 * 1024;
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
function signature(file: string) {
  const result = spawnSync("/usr/bin/codesign", ["-dvvv", file], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 32768,
  });
  return { status: result.status, details: result.stderr.slice(0, 16000) };
}
type DiagnosticRender = {
  window: BrowserWindow;
  requestedHTML: string;
  loadedHTML: string;
  loading: boolean;
};

export class DockValidation {
  private child?: ChildProcessWithoutNullStreams;
  get running() {
    return this.child !== undefined;
  }
  private window?: BrowserWindow;
  private state = "Not started";
  private renderJob?: DiagnosticRender;
  private renderRevision = 0;
  private currentness = "Unavailable";
  private orientation: "bottom" | "left" | "right" = "bottom";
  private destination = "Created when validation starts";
  private fd?: number;
  private bytes = 0;
  private stopping = false;
  private stopReason = "";
  private blocked = false;
  private protocolEnvironment = false;
  private nativeFinished = false;
  private timer?: NodeJS.Timeout;
  private killTimer?: NodeJS.Timeout;
  private closePromise?: Promise<void>;
  private transportTimer?: NodeJS.Timeout;
  private environmentReceivedAt = 0;
  private lastHeartbeatAt = 0;
  private lastHeartbeatElapsed = 0;
  private streamConfigured = false;
  constructor(private changed: () => void) {
    powerMonitor.on("suspend", () => {
      void this.stop("system sleep; start a new run after waking");
    });
    powerMonitor.on("resume", () => {
      if (!this.child && this.window) {
        this.state = "Stopped: system wake; start a new run explicitly";
        this.render();
      }
    });
  }
  menu(): MenuItemConstructorOptions[] {
    return [
      {
        label: "Start Dock validation (120 seconds)",
        enabled: !this.child,
        click: () => this.start(),
      },
      {
        label: "Stop Dock validation",
        click: () => {
          void this.stop("user stop");
        },
      },
      { label: "Show Dock validation status", click: () => this.show() },
      {
        label: "Operator Dock orientation",
        submenu: (["bottom", "left", "right"] as const).map((orientation) => ({
          label: orientation,
          type: "radio",
          checked: this.orientation === orientation,
          enabled: !this.child,
          click: () => {
            this.orientation = orientation;
            this.render();
            this.changed();
          },
        })),
      },
    ];
  }
  private show() {
    if (!this.window || this.window.isDestroyed()) {
      this.window = new BrowserWindow({
        title: "Mosey Dock validation",
        width: 720,
        height: 470,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      this.window.webContents.on("will-navigate", (event) =>
        event.preventDefault(),
      );
      const window = this.window;
      this.renderJob = {
        window,
        requestedHTML: "",
        loadedHTML: "",
        loading: false,
      };
      window.on("closed", () => {
        if (this.window !== window) return;
        this.window = undefined;
        this.renderJob = undefined;
      });
    }
    this.render();
    this.window.show();
  }
  private render() {
    const revision = ++this.renderRevision;
    if (!this.window || this.window.isDestroyed()) return;
    const body = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Mosey Dock validation</title><style>body{font:16px system-ui;margin:28px;color:#242424;background:#faf9f7}p{line-height:1.5}input{box-sizing:border-box;width:100%;padding:8px}small{line-height:1.5}</style></head><body><h1>Dock validation</h1><p role="status">${escape(this.state)}</p><p>Latest validated native currentness: ${escape(this.currentness)}</p><p>Operator orientation: ${this.orientation}. Confirm the actual Dock position before starting.</p><label>Local log<input aria-label="Local log" readonly value="${escape(this.destination)}"></label><p>Electron screen-recording status: ${escape(systemPreferences.getMediaAccessStatus("screen"))}. Native preflight is reported separately above.</p><small>Experimental local statistics, bounded to 120 seconds. No pet collision edge is accepted. Start and Stop are available in the Dock validation menu. Permission changes require your own System Settings action.</small></body></html>`;
    const job = this.renderJob;
    // Reentrant input can request a newer document while this snapshot is
    // being built. Only the latest render may publish to the navigation queue.
    if (!job || revision !== this.renderRevision) return;
    job.requestedHTML = body;
    if (job.loading || body === job.loadedHTML) return;
    void this.loadLatest(job);
  }
  private async loadLatest(job: DiagnosticRender): Promise<void> {
    if (this.renderJob !== job || job.window.isDestroyed()) return;
    const body = job.requestedHTML;
    job.loading = true;
    try {
      await job.window.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(body)}`,
      );
      if (this.renderJob === job) job.loadedHTML = body;
    } catch {
      job.loadedHTML = "";
      // A future render may retry; a failed navigation must not loop itself.
    } finally {
      job.loading = false;
      if (
        this.renderJob === job &&
        !job.window.isDestroyed() &&
        job.requestedHTML !== body
      ) {
        void this.loadLatest(job);
      }
    }
  }
  private record(value: unknown) {
    if (this.fd === undefined) return;
    const line = Buffer.from(JSON.stringify(value) + "\n");
    if (this.bytes + line.length > MAX_BYTES)
      throw new Error("Local diagnostic log reached its 8 MiB limit");
    fs.writeSync(this.fd, line);
    this.bytes += line.length;
  }
  start() {
    if (this.child) return;
    clearTimeout(this.timer);
    clearTimeout(this.killTimer);
    clearInterval(this.transportTimer);
    this.timer = undefined;
    this.killTimer = undefined;
    this.transportTimer = undefined;
    this.closePromise = undefined;
    this.stopReason = "";
    this.environmentReceivedAt = 0;
    this.lastHeartbeatAt = 0;
    this.lastHeartbeatElapsed = 0;
    this.streamConfigured = false;
    this.stopping = false;
    this.blocked = false;
    this.protocolEnvironment = false;
    this.nativeFinished = false;
    this.currentness = "Unavailable";
    this.show();
    try {
      const directory = path.join(app.getPath("userData"), "dock-validation");
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Keep at most three completed/current diagnostic runs, each bounded separately.
      const old = fs
        .readdirSync(directory)
        .filter((name) => /^run-[\da-f-]+\.jsonl$/.test(name))
        .sort(
          (a, b) =>
            fs.statSync(path.join(directory, b)).mtimeMs -
            fs.statSync(path.join(directory, a)).mtimeMs,
        );
      for (const name of old.slice(2))
        fs.unlinkSync(path.join(directory, name));
      this.destination = path.join(directory, `run-${randomUUID()}.jsonl`);
      this.fd = fs.openSync(this.destination, "wx", 0o600);
      this.bytes = 0;
      const nativeDirectory = app.isPackaged
        ? path.join(process.resourcesPath, "native")
        : path.join(app.getAppPath(), "build/native");
      const helper = path.join(nativeDirectory, "dock-live");
      const receipt = helperReceiptSchema.parse(
        JSON.parse(
          fs.readFileSync(path.join(nativeDirectory, "receipt.json"), "utf8"),
        ),
      );
      const verified = spawnSync(
        "/usr/bin/codesign",
        ["--verify", "--strict", helper],
        { timeout: 5000, maxBuffer: 16384 },
      );
      if (verified.status !== 0)
        throw new Error("Native helper signature verification failed");
      const helperSHA256 = createHash("sha256")
        .update(fs.readFileSync(helper))
        .digest("hex");
      const primaryDisplay = screen.getPrimaryDisplay();
      this.record({
        type: "electron-host",
        primaryDisplay: {
          id: primaryDisplay.id,
          bounds: primaryDisplay.bounds,
          scaleFactor: primaryDisplay.scaleFactor,
          workAreaDiagnosticOnly: primaryDisplay.workArea,
        },
        transportPolicy: {
          heartbeatTimeoutMs: 2000,
          startupTimeoutMs: 10000,
          maxLineBytes: MAX_LINE,
          maxRunBytes: MAX_BYTES,
          maxRetainedRuns: 3,
          nativeDurationSeconds: 120,
          hostDeadlineSeconds: 125,
          killEscalationMs: 1500,
        },
        electron: process.versions.electron,
        node: process.versions.node,
        version: app.getVersion(),
        packaged: app.isPackaged,
        appPath: app.getAppPath(),
        executable: process.execPath,
        processID: process.pid,
        parentPID: process.ppid,
        helperPath: helper,
        helperSHA256,
        helperSignature: signature(helper),
        topLevelSignature: signature(
          path.dirname(path.dirname(path.dirname(process.execPath))),
        ),
        buildReceipt: receipt,
        electronScreenPermissionDiagnosticOnly:
          systemPreferences.getMediaAccessStatus("screen"),
        operatorOrientation: this.orientation,
        supportEdge: null,
      });
      this.state = "Checking native screen-recording permission";
      this.child = spawn(
        helper,
        [
          "--no-app-status",
          "--duration",
          "120",
          "--interval",
          "0.1",
          "--idle-current",
          "--orientation",
          this.orientation,
          "--scenario",
          "formal-electron-diagnostic",
        ],
        { shell: false, stdio: ["pipe", "pipe", "pipe"] },
      );
      this.child.stdin.end();
      const child = this.child;
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let stderrBytes = 0;
      const fail = (reason: string) => {
        this.state = `Failed: ${reason}`;
        this.currentness = "Unavailable";
        void this.stop(reason, true);
      };
      child.stdout.on("data", (data: Buffer) => {
        if (this.stopping) return;
        try {
          buffer += decoder.write(data);
          if (Buffer.byteLength(buffer) > MAX_LINE && !buffer.includes("\n"))
            throw new Error("Native record exceeds line limit");
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (Buffer.byteLength(line) > MAX_LINE)
              throw new Error("Native record exceeds line limit");
            const parsed = dockRecordSchema.parse(JSON.parse(line));
            if (this.nativeFinished)
              throw new Error("Native record after summary");
            if (this.blocked && parsed.type !== "summary")
              throw new Error("Native record after permission denial");
            if (
              (parsed.type === "frame" || parsed.type === "heartbeat") &&
              !this.streamConfigured
            )
              throw new Error("Native statistics before stream configuration");
            if (parsed.type === "stream_configuration" && this.streamConfigured)
              throw new Error("Duplicate native stream configuration");
            if (!this.protocolEnvironment && parsed.type !== "environment")
              throw new Error("Native environment record missing");
            if (parsed.type === "environment") {
              if (
                this.protocolEnvironment ||
                parsed.processID !== child.pid ||
                parsed.parentPID !== process.pid ||
                parsed.orientation !== this.orientation
              )
                throw new Error("Native launch identity mismatch");
              this.protocolEnvironment = true;
              this.environmentReceivedAt = performance.now();
            }
            if (parsed.type === "summary") {
              if (parsed.status === "permission_unavailable" && !this.blocked)
                throw new Error(
                  "Native permission summary lacks no-query evidence",
                );
              if (parsed.status === "completed" && !this.streamConfigured)
                throw new Error(
                  "Native completion without stream configuration",
                );
              this.nativeFinished = true;
            }
            this.record({
              type: "native",
              receivedAtMonotonicMs: performance.now(),
              record: parsed,
            });
            if (parsed.type === "unavailable") {
              if (
                parsed.status === "permission_unavailable" &&
                parsed.shareableContentQueryAttempted === false
              ) {
                this.blocked = true;
                this.state =
                  "Blocked: native screen-recording permission unavailable";
              } else
                throw new Error(
                  `Native observation unavailable: ${parsed.status}`,
                );
            }
            if (parsed.type === "stream_error")
              throw new Error("Native stream error");
            if (parsed.type === "stream_configuration") {
              this.state = "Capturing diagnostic statistics";
              this.streamConfigured = true;
              this.lastHeartbeatAt = performance.now();
            }
            if (parsed.type === "heartbeat") {
              const now = performance.now();
              // Relative progression only: do not assume Node and mach share an epoch.
              const addedDelayLowerBound =
                (now - this.environmentReceivedAt) / 1000 - parsed.elapsed;
              if (
                parsed.elapsed < this.lastHeartbeatElapsed ||
                addedDelayLowerBound > 2
              )
                throw new Error("Native heartbeat progression is stale");
              this.lastHeartbeatElapsed = parsed.elapsed;
              this.lastHeartbeatAt = now;
              this.currentness = parsed.candidateStatus;
            }
            if (
              parsed.type === "summary" &&
              parsed.status !== "completed" &&
              parsed.status !== "permission_unavailable"
            )
              throw new Error(`Native observation stopped: ${parsed.status}`);
          }
          if (Buffer.byteLength(buffer) > MAX_LINE)
            throw new Error("Native record exceeds line limit");
          this.render();
        } catch (error) {
          fail(
            error instanceof Error
              ? error.message.slice(0, 180)
              : "Invalid native record",
          );
        }
      });
      child.stderr.on("data", (data: Buffer) => {
        stderrBytes += data.length;
        if (stderrBytes > 32768) fail("Native stderr exceeded limit");
      });
      child.once("error", () => fail("Native process could not start"));
      this.closePromise = new Promise<void>((resolve) =>
        child.once("close", (code, signal) => {
          clearTimeout(this.timer);
          clearTimeout(this.killTimer);
          clearInterval(this.transportTimer);
          this.timer = undefined;
          this.killTimer = undefined;
          this.transportTimer = undefined;
          try {
            buffer += decoder.end();
            if (!this.stopping && buffer.length !== 0)
              this.state = "Failed: truncated native record";
            else if (!this.stopping && !this.protocolEnvironment)
              this.state = "Failed: native environment record missing";
            else if (!this.stopping && !this.nativeFinished)
              this.state = "Failed: native summary record missing";
            else if (this.stopping && !this.state.startsWith("Failed:"))
              this.state = `Stopped: ${this.stopReason}`;
            else if (!this.stopping && !this.blocked)
              this.state =
                code === 0
                  ? "Stopped: bounded observation completed"
                  : `Failed: native exit ${code ?? signal}`;
            this.record({
              type: "electron-stop",
              code,
              signal,
              reason: this.stopReason || "native completion",
              supportEdge: null,
            });
          } catch {
            this.state = "Failed: local log unavailable";
          }
          if (this.fd !== undefined) fs.closeSync(this.fd);
          this.fd = undefined;
          this.child = undefined;
          this.currentness = "Unavailable";
          this.render();
          this.changed();
          resolve();
        }),
      );
      const launchedAt = performance.now();
      this.transportTimer = setInterval(() => {
        if (this.stopping || this.blocked) return;
        const now = performance.now();
        if (this.streamConfigured && now - this.lastHeartbeatAt > 2000)
          fail("native output heartbeat unavailable");
        else if (!this.streamConfigured && now - launchedAt > 10000)
          fail("native startup heartbeat unavailable");
      }, 250);
      this.timer = setTimeout(() => {
        void this.stop("Electron 125-second deadline");
      }, 125000);
      this.render();
      this.changed();
    } catch (error) {
      this.state = `Failed: ${error instanceof Error ? error.message.slice(0, 180) : "Native setup failed"}`;
      if (this.fd !== undefined) fs.closeSync(this.fd);
      this.fd = undefined;
      this.render();
      this.changed();
    }
  }
  async stop(reason: string, preserveFailure = false) {
    this.stopReason = reason;
    this.stopping = true;
    this.currentness = "Unavailable";
    if (!preserveFailure)
      this.state = this.child ? `Stopping: ${reason}` : `Stopped: ${reason}`;
    this.render();
    if (!this.child) return;
    const child = this.child;
    child.kill("SIGTERM");
    this.killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1500);
    await this.closePromise;
  }
}
