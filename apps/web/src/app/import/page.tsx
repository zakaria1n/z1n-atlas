import Link from "next/link";
import { LocalImport } from "@/features/repository-import/local-import";
import { GitHubImport } from "@/features/repository-import/github-import";
import { Header } from "@/components/layout/header";

export default function ImportPage() {
  return (
    <div className="shell">
      <Header />
      <main className="interior">
        <p className="eyebrow">Start exploring</p>
        <h1>Open a project.</h1>
        <p className="intro">
          Read a public repository or choose a local folder.
        </p>
        <div className="options">
          <GitHubImport />
          <LocalImport />
        </div>
        <p className="privacy">
          Z1N Atlas is designed for read-only exploration. Your files will not
          be modified or executed.
        </p>
        <Link href="/workspace" className="text-link">
          Open workspace →
        </Link>
      </main>
    </div>
  );
}
