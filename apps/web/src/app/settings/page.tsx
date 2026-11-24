import { Header } from "@/components/layout/header";

export default function SettingsPage() {
  return (
    <div className="shell">
      <Header />
      <main className="interior narrow">
        <p className="eyebrow">Your preferences</p>
        <h1>Settings.</h1>
        <p className="intro">AI provider settings are not available yet.</p>
        <section className="notice">
          <h2>Bring your own key</h2>
          <p>
            Support for OpenAI, Google Gemini and Anthropic is planned. Provider
            keys cannot be configured in this version.
          </p>
        </section>
      </main>
    </div>
  );
}
