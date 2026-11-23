import Link from "next/link";
import { Header } from "@/components/layout/header";

export default function ImportPage() {
  return (
    <div className="shell">
      <Header />
      <main className="interior">
        <p className="eyebrow">Start exploring</p>
        <h1>Open a project.</h1>
        <p className="intro">
          Choose how you would like to bring a project into your atlas. Import
          is not available yet.
        </p>
        <div className="options">
          <section className="option">
            <div className="option-icon" aria-hidden="true">
              ↗
            </div>
            <h2>Public GitHub repository</h2>
            <p>Explore a public repository by its GitHub URL.</p>
            <button disabled>GitHub import coming soon</button>
          </section>
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
