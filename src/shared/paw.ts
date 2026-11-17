// A paw drawn in a 24-unit square: one pad and four toes, spaced so the toes
// stay apart at 16 pixels. The menu bar icon and the settings window draw it.
export const paw = {
  pad: { x: 12, y: 16.2, rx: 5.6, ry: 4.8 },
  toes: [
    { x: 4.3, y: 9.6 },
    { x: 8.8, y: 5.2 },
    { x: 15.2, y: 5.2 },
    { x: 19.7, y: 9.6 },
  ],
  toeRadius: 2.3,
} as const;
