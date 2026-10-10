export function counterDeltas<T>(
  history: readonly T[],
  readValue: (sample: T) => number,
): number[] {
  return history.slice(1).map((current, index) => {
    const previous = history[index];
    return Math.max(0, readValue(current) - readValue(previous));
  });
}
