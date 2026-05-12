import { useSeoMeta } from "@unhead/react";
import { useEffect } from "react";
import { CheckCircle2 } from "lucide-react";

// Callback target for mobile NIP-46 signer apps after they approve a
// `nostrconnect://` request. The actual login completes via the relay
// subscription in the original tab — this page just provides a friendly
// landing if the signer opened it in a new tab/window.
const RemoteLoginSuccess = () => {
  useSeoMeta({
    title: "Signer connected",
    description: "You can return to Shakespeare.",
  });

  useEffect(() => {
    // Best-effort: most signers open this in a new tab. Try to close it;
    // the manual link below is the fallback when the browser refuses.
    window.setTimeout(() => {
      try {
        window.close();
      } catch {
        // ignored
      }
    }, 500);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="text-center space-y-4 max-w-sm">
        <CheckCircle2 className="w-12 h-12 mx-auto text-green-500" />
        <h1 className="text-2xl font-semibold text-foreground">Signer connected</h1>
        <p className="text-muted-foreground">
          You can return to Shakespeare. Your login should complete automatically.
        </p>
        <a href="/" className="inline-block text-primary hover:text-primary/80 underline">
          Open Shakespeare
        </a>
      </div>
    </div>
  );
};

export default RemoteLoginSuccess;
