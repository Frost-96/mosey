import idleUrl from "./assets/corgi-idle.png";
const canvas = document.querySelector("canvas");
if (!canvas) throw new Error("Pet canvas is absent");
const context = canvas.getContext("2d");
if (!context) throw new Error("Canvas 2D is unavailable");
const image = new Image();
image.src = idleUrl;
await image.decode();
const cell = image.width / 2;
let previous = -1;
const started = performance.now();
function draw(now: number) {
  const frame = Math.floor((now - started) / 160) % 4;
  if (frame !== previous) {
    context!.clearRect(0, 0, 240, 240);
    context!.drawImage(
      image,
      (frame % 2) * cell,
      Math.floor(frame / 2) * cell,
      cell,
      cell,
      0,
      0,
      240,
      240,
    );
    previous = frame;
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
