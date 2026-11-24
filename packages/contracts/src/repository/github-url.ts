export type GitHubRepository = { owner: string; name: string; url: string };

export function parseGitHubRepository(input: string): GitHubRepository | null {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/i.exec(
      input.trim(),
    );
  if (!match) return null;
  const owner = match[1];
  const name = match[2].replace(/\.git$/i, "");
  if (
    !name ||
    name === "." ||
    name === ".." ||
    owner.startsWith("-") ||
    owner.endsWith("-") ||
    owner.includes("--") ||
    owner.length > 39 ||
    name.length > 100
  )
    return null;
  return { owner, name, url: `https://github.com/${owner}/${name}` };
}
