import { Header } from "@/components/layout/header";
import { ProviderSettings } from "@/features/provider-settings/provider-settings";

export default function SettingsPage() {
  return (
    <div className="shell">
      <Header />
      <main className="interior narrow">
        <p className="eyebrow">Your preferences</p>
        <h1>Settings.</h1>
        <p className="intro">
          Choose how your atlas connects to an AI provider.
        </p>
        <ProviderSettings />
      </main>
    </div>
  );
}
