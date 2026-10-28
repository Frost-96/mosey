import type { MenuItemConstructorOptions } from "electron";
import { DockRuntime, type DockObservation } from "./runtime";
import { DockValidation } from "./validation";

type Application = {
  permitted(): boolean;
  observe(observation: DockObservation | null, processingFrame: boolean): void;
  changed(): void;
};

// Own the exclusive capture choice and retire superseded asynchronous requests.
// Visibility and suspension remain application facts, checked at every start.
export class DockCapture {
  private readonly runtime: DockRuntime;
  private readonly validation: DockValidation;
  private mode: "product" | "diagnostic" = "product";
  private revision = 0;
  private quitting = false;

  constructor(private readonly application: Application) {
    this.validation = new DockValidation(application.changed);
    let status = "";
    this.runtime = new DockRuntime((observation) => {
      application.observe(observation, this.runtime.processingFrame);
      if (status !== this.runtime.status) {
        status = this.runtime.status;
        application.changed();
      }
    });
  }

  get status() {
    return this.runtime.status;
  }

  start() {
    if (
      !this.quitting &&
      this.mode === "product" &&
      this.application.permitted() &&
      !this.validation.running
    )
      this.runtime.start();
  }

  stop() {
    return this.runtime.stop();
  }

  private reserve(mode: "product" | "diagnostic") {
    this.mode = mode;
    return ++this.revision;
  }

  retry = () => {
    const revision = this.reserve("product");
    this.runtime.resetRecoveryBudget();
    void Promise.all([
      this.runtime.stop(),
      this.validation.stop("product Dock interaction requested"),
    ]).then(() => {
      if (revision === this.revision) this.start();
    });
  };

  menu(): MenuItemConstructorOptions {
    return {
      label: "Dock validation",
      submenu: this.validation.menu({
        start: () => {
          const revision = this.reserve("diagnostic");
          void this.runtime.stop().then(() => {
            if (
              !this.quitting &&
              this.mode === "diagnostic" &&
              revision === this.revision
            )
              return this.validation.start();
          });
        },
        stop: () => {
          const revision = this.reserve("product");
          void this.validation.stop("user stop").then(() => {
            if (revision === this.revision) this.start();
          });
        },
      }),
    };
  }

  shutdown() {
    this.quitting = true;
    return Promise.all([
      this.validation.stop("application quit"),
      this.runtime.stop(),
    ]);
  }
}
