import { Header } from "@/components/layout/header";
import { EmptyWorkspace } from "@/features/workspace/empty-workspace";

export default function WorkspacePage() {
  return (
    <div className="shell workspace-shell">
      <Header />
      <EmptyWorkspace />
    </div>
  );
}
