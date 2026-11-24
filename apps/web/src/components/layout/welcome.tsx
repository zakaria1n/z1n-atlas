import Image from "next/image";
import Link from "next/link";
import { Header } from "./header";

export function Welcome() {
  return (
    <div className="shell">
      <Header />
      <main id="main" className="hero">
        <div className="hero-copy">
          <p className="eyebrow">
            <span aria-hidden="true" /> A new perspective
          </p>
          <h1>Understand the shape of your code.</h1>
          <p className="intro">
            Explore the connections in a codebase and find your way from
            questions to evidence.
          </p>
          <Link className="button primary" href="/import">
            Explore a project <span aria-hidden="true">→</span>
          </Link>
          <p className="availability">
            Explore public GitHub repositories or local projects with source
            evidence and an optional AI assistant.
          </p>
        </div>
        <div className="hero-art">
          <Image
            src="/assets/hero-graph.svg"
            alt=""
            width={800}
            height={800}
            priority
          />
        </div>
      </main>
      <footer className="footer">
        <span>Visualize. Explore. Understand.</span>
        <span>Read-only by design.</span>
      </footer>
    </div>
  );
}
