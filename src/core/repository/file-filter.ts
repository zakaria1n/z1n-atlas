const allowedExtension = /\.(?:[cm]?[jt]sx?|json|css|html|md)$/i;
const excludedDirectory =
  /^(?:node_modules|\.git|\.next|dist|build|out|coverage|vendor|\.turbo)$/i;
const excludedName =
  /(?:^\.|(?:^|[._-])(?:secret|secrets|credential|credentials|private|token|password|key)(?:[._-]|$)|(?:^|[._-])lock\.)/i;

export function isEligiblePath(path: string): boolean {
  const parts = path.split("/");
  return (
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
