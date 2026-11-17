// Told apart from a probe that answered with an error: only a missed deadline
// shows that the process behind the driver stopped responding.
export class DeadlineExceeded extends Error {}

// Driver calls can stay pending after a test times out. A separate deadline
// lets the owner close its process; a later rejection remains observed by race.
export async function withinDeadline<T>(
  label: string,
  operation: () => T | Promise<T>,
  milliseconds = 1000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new DeadlineExceeded(
                `${label} exceeded its ${milliseconds}ms deadline`,
              ),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
