import { useDaemonStore } from "../stores/daemon-store.js";

export function SessionInvalidBanner(): JSX.Element | null {
  const sessionInvalid = useDaemonStore((s) => s.sessionInvalid);
  if (!sessionInvalid) return null;
  return (
    <div role="alert" className="session-invalid-banner">
      console restarted — reload{" "}
      <button
        type="button"
        onClick={() => {
          window.location.reload();
        }}
      >
        Reload
      </button>
    </div>
  );
}
