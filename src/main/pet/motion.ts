import { screen, type BrowserWindow } from "electron";
import type { ActorRefFrom, SnapshotFrom } from "xstate";
import { petBehavior, autonomy } from "../../behavior/pet-machine";
import type { PetSize } from "../../shared/size";
import type { CharacterSwitch } from "./character-switch";
import type { Footing, FootingBody } from "./footing";
import type { Presence } from "./presence";

type Scene = {
  // A captured gesture froze the behavior timeline.
  readonly paused: boolean;
  readonly gestureActive: boolean;
  readonly size: PetSize;
  readonly character: CharacterSwitch["current"];
  // The body as painted right now, for footing to measure.
  body(): FootingBody;
  // Follow the Dock once this tick's placement is applied.
  reconcile(): void;
};

// Own the single motion timer and its action identity. Scene getters stay live
// across native calls; the application never manages per-motion progress.
// Support, placement and the pending-frame hold come from footing directly.
// A walk or climb stops once presence no longer shows the pet. Quitting keeps
// it shown, so motion continues while Dock capture drains instead of freezing.
export class PetMotion {
  private timer: ReturnType<typeof setInterval> | undefined;
  private action = -1;
  constructor(
    private readonly pet: BrowserWindow,
    private readonly behavior: ActorRefFrom<typeof petBehavior>,
    private readonly footing: Footing,
    private readonly presence: Presence,
    private readonly scene: Scene,
  ) {}

  // Motion time stands still while a pending Dock frame holds movement.
  private get movementNow() {
    return this.footing.movementNow();
  }

  // Either the timeline is paused or a pending Dock frame holds movement.
  private get held() {
    return this.scene.paused || this.footing.holding;
  }

  private supportAt(x: number, y: number) {
    return this.footing.supportAt(this.scene.body(), { x, y });
  }

  get active() {
    return this.timer !== undefined;
  }

  stop = () => {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.action = -1;
  };

  update(snapshot: SnapshotFrom<typeof petBehavior>) {
    // Rendering chooses poses by time. Only the main process moves the window.
    if (
      snapshot.value === "walking" &&
      this.action !== snapshot.context.actionId
    ) {
      this.stop();
      const id = snapshot.context.actionId;
      this.action = id;
      const origin = this.pet.getBounds();
      const area = screen.getPrimaryDisplay().workArea;
      const walk = this.scene.character.walk;
      const walkDistance = walk
        ? (walk.distance * this.scene.size) / walk.referenceWindowSize
        : autonomy.walkDistance;
      let direction = snapshot.context.direction === "left" ? -1 : 1;
      // At an edge, use the available direction instead of walking in place.
      if (
        origin.x + direction * walkDistance < area.x ||
        origin.x + direction * walkDistance > area.x + area.width - origin.width
      )
        direction *= -1;
      if ((direction < 0 ? "left" : "right") !== snapshot.context.direction) {
        this.behavior.send({
          type: "FACE",
          direction: direction < 0 ? "left" : "right",
        });
      }
      const destination = Math.max(
        area.x,
        Math.min(
          origin.x + direction * walkDistance,
          area.x + Math.max(0, area.width - origin.width),
        ),
      );
      const started = this.movementNow;
      const originFootX = origin.x + origin.width / 2;
      let previousFootX = originFootX;
      let avoidanceOffset = 0;
      this.timer = setInterval(() => {
        if (this.held) return;
        if (
          this.pet.isDestroyed() ||
          this.scene.gestureActive ||
          !this.presence.shown ||
          this.behavior.getSnapshot().context.actionId !== id
        )
          return this.stop();
        const progress = walk
          ? walk.progress(this.movementNow - started)
          : Math.min(1, (this.movementNow - started) / autonomy.walkMs);
        const bounds = this.pet.getBounds();
        // A size change preserves the moving foot, not the old window corner.
        // Preserve both corrections applied by this tick and any newer native
        // contour that moved the window between ticks. Keep the fractional
        // original path so integer window rounding cannot accumulate drift.
        avoidanceOffset += bounds.x + bounds.width / 2 - previousFootX;
        const x =
          originFootX +
          (destination - origin.x) * progress -
          bounds.width / 2 +
          avoidanceOffset;
        const support = this.supportAt(x, bounds.y);
        this.footing.constrain(x + support.shiftX, bounds.y);
        const moved = this.pet.getBounds();
        avoidanceOffset += moved.x - Math.round(x);
        previousFootX = moved.x + moved.width / 2;
        this.scene.reconcile();
      }, 16);
    } else if (
      snapshot.value === "climbing" &&
      this.action !== snapshot.context.actionId
    ) {
      this.stop();
      const id = snapshot.context.actionId;
      this.action = id;
      const started = this.movementNow;
      const climbDurationMs = this.scene.character.atlases
        .find((atlas) => atlas.action === "climbing")!
        .frames.reduce((total, frame) => total + frame.durationMs, 0);
      let last = started;
      this.timer = setInterval(() => {
        if (this.held) {
          last = this.movementNow;
          return;
        }
        if (
          this.pet.isDestroyed() ||
          this.scene.gestureActive ||
          !this.presence.shown ||
          this.behavior.getSnapshot().context.actionId !== id
        )
          return this.stop();
        const now = this.movementNow;
        const step = Math.min(50, now - last) * 0.11;
        last = now;
        const bounds = this.pet.getBounds();
        const target = this.supportAt(bounds.x, bounds.y).footY;
        const footY = bounds.y + bounds.height;
        if (target > footY + 1) {
          this.behavior.send({ type: "DROP" });
          return;
        }
        const next = Math.max(target, footY - step);
        this.footing.constrain(bounds.x, next - bounds.height);
        if (next <= target + 1 && now - started >= climbDurationMs) {
          this.stop();
          this.behavior.send({ type: "LANDED", actionId: id });
        }
      }, 16);
    } else if (
      snapshot.value !== "falling" &&
      snapshot.value !== "walking" &&
      snapshot.value !== "climbing"
    )
      this.stop();
    else if (
      snapshot.value === "falling" &&
      this.action !== snapshot.context.actionId
    ) {
      this.stop();
      const id = snapshot.context.actionId;
      this.action = id;
      const origin = this.pet.getBounds();
      const footY = origin.y + origin.height;
      const started = this.movementNow;
      // Initial velocity and acceleration in desktop points, adjustable here.
      this.timer = setInterval(() => {
        if (this.held) return;
        if (
          this.pet.isDestroyed() ||
          this.scene.gestureActive ||
          this.behavior.getSnapshot().context.actionId !== id
        ) {
          this.stop();
          return;
        }
        const seconds = (this.movementNow - started) / 1000;
        const bounds = this.pet.getBounds();
        const y =
          footY - bounds.height + 180 * seconds + 1800 * seconds * seconds;
        const ground = this.supportAt(bounds.x, y).footY - bounds.height;
        if (ground < bounds.y - 1) {
          this.behavior.send({ type: "CLIMB" });
          return;
        }
        const support = this.supportAt(bounds.x, y);
        this.footing.constrain(bounds.x + support.shiftX, Math.min(y, ground));
        if (y >= ground) {
          this.stop();
          this.behavior.send({ type: "LANDED", actionId: id });
        }
      }, 16);
    }
  }
}
