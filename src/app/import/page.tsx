import Link from "next/link";
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
          Read a public repository or choose a local folder when that option is
          available.
        </p>
        <div className="options">
          <GitHubImport />
          <section className="option">
            <div className="option-icon mint" aria-hidden="true">
              ⌑
            </div>
            <h2>Local folder</h2>
            <p>Choose a folder explicitly from your device.</p>
            <button disabled>Local import coming soon</button>
          </section>
        </div>
        <p className="privacy">
          Z1N Atlas is designed for read-only exploration. Your files will not
          be modified or executed.
        </p>
        <Link href="/workspace" className="text-link">
          See the empty workspace →
        </Link>
      </main>
    </div>
  );
}
