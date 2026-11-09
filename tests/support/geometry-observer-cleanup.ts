type GeometryCleanup = {
  records?: () => Promise<unknown>;
  stop: () => Promise<unknown>;
  dispose: () => Promise<unknown>;
};

export async function finishGeometryObservation(
  operations: GeometryCleanup,
  timeoutMs = 1000,
) {
  const evidence: { records?: unknown; unavailable: string[] } = {
    unavailable: [],
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ unavailable: string }>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({ unavailable: `Geometry cleanup exceeded ${timeoutMs}ms` }),
      timeoutMs,
    );
  });
  try {
    for (const stage of ["records", "stop", "dispose"] as const) {
      const operation = operations[stage];
      if (!operation) continue;
      // One budget covers all stages. Still attempt later releases after a
      // stalled read/stop, without holding up the session's process cleanup.
      const result = await Promise.race([
        Promise.resolve()
          .then(operation)
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ unavailable: String(error) }),
          ),
        deadline,
      ]);
      if ("unavailable" in result)
        evidence.unavailable.push(`${stage}: ${result.unavailable}`);
      else if (stage === "records") evidence.records = result.value;
    }
    return evidence;
  } finally {
    clearTimeout(timer);
  }
}
