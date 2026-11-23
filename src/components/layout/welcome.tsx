import Image from "next/image";

export function Welcome() {
  return (
    <div className="shell">
      <header className="header">
        <Image
          src="/assets/logo-horizontal.svg"
          alt="Z1N Atlas"
          width={180}
          height={45}
          priority
        />
        <span className="header-note">A clearer view of code</span>
      </header>
      <main id="main" className="main">
        <div className="eyebrow">
          <span aria-hidden="true" /> A new perspective
        </div>
        <h1>Understand the shape of your code.</h1>
        <p className="intro">
          Z1N Atlas is being built to help you explore codebases through their
          connections and evidence-backed explanations.
        </p>
        <div className="status">
          <span className="status-label">In development</span>
          <p>
            Repository exploration and AI explanations are planned and are not
            available yet.
          </p>
        </div>
      </main>
      <footer className="footer">
        <span>Visualize. Explore. Understand.</span>
        <span>Built for curious minds.</span>
      </footer>
    </div>
  );
}
