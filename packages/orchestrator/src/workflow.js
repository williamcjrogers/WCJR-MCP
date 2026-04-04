/**
 * Build ordered batches of phases for execution. Each batch is an array of phases
 * to run in parallel (Promise.all). Batches run sequentially.
 * @param { Array<{ id: string, dependsOn: string[], parallelGroup: number }> } phases
 * @returns { Array<Array<typeof phases[0]>> }
 */
export function buildExecutionBatches(phases) {
  if (!phases?.length) return [];
  const byId = Object.fromEntries(phases.map((p) => [p.id, p]));
  const orderIndex = Object.fromEntries(phases.map((p, i) => [p.id, i]));
  const remaining = new Set(phases.map((p) => p.id));
  const completed = new Set();
  const batches = [];

  while (remaining.size) {
    const runnable = [...remaining].filter((id) => {
      const ph = byId[id];
      return (ph.dependsOn ?? []).every((d) => completed.has(d));
    });
    if (!runnable.length) {
      throw new Error("Invalid workflow: circular dependency or unknown dependsOn reference.");
    }
    runnable.sort((a, b) => orderIndex[a] - orderIndex[b]);

    const groupKeys = [...new Set(runnable.map((id) => byId[id].parallelGroup ?? 0))].sort(
      (a, b) => a - b
    );

    for (const g of groupKeys) {
      const groupIds = runnable.filter((id) => (byId[id].parallelGroup ?? 0) === g);
      groupIds.sort((a, b) => orderIndex[a] - orderIndex[b]);
      batches.push(groupIds.map((id) => byId[id]));
      for (const id of groupIds) {
        remaining.delete(id);
        completed.add(id);
      }
    }
  }

  return batches;
}
