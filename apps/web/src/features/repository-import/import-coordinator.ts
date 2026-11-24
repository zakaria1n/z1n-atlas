export function createImportCoordinator() {
  let generation = 0;
  return {
    begin() {
      const current = ++generation;
      return () => generation === current;
    },
  };
}
