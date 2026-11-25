const allowedExtension = /\.(?:[cm]?[jt]sx?|py|json|css|html|md)$/i;
// Build-output directories are not excluded: several real projects develop
// directly in them, the tiered selection already ranks tests and generated
// code last, and the byte budget bounds what a large checkout can cost.
const excludedDirectory =
  /^(?:node_modules|\.git|\.next|coverage|vendor|\.turbo)$/i;
const excludedName =
  /(?:^\.|(?:^|[._-])(?:secret|secrets|credential|credentials|private|token|password|key)(?:[._-]|$)|(?:^|[._-])lock\.)/i;

export function isEligiblePath(path: string): boolean {
  const parts = path.split("/");
  return (
    path.length <= 500 &&
    parts.length > 0 &&
    parts.every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        !part.includes("\\") &&
        !/[\x00-\x1f]/.test(part),
    ) &&
    !parts
      .slice(0, -1)
      .some(
        (part) => excludedName.test(part) || excludedDirectory.test(part),
      ) &&
    !excludedName.test(parts[parts.length - 1]) &&
    allowedExtension.test(path)
  );
}
