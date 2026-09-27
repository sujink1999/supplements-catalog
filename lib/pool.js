// A work queue with N workers. One per-item failure must never lose the rest of the run:
// legacy logged and continued, and so does this.
export async function pool(items, conc, worker) {
  const queue = [...items];
  let done = 0;
  const errors = [];
  await Promise.all(
    Array.from({ length: Math.max(1, conc) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          await worker(item, ++done);
        } catch (e) {
          if (e.budgetExceeded) {
            queue.length = 0;
            errors.push(e);
            return;
          }
          errors.push(e);
          console.log(`ERR ${e.message.slice(0, 160)}`);
        }
      }
    }),
  );
  return { done, errors };
}
