import { useState } from "react";
import { useInstallPrompt } from "../hooks/useInstallPrompt";

function DownloadIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v13M7 11l5 5 5-5M4 21h16" />
    </svg>
  );
}

function IosHint() {
  return (
    <div className="rise mt-2.5 rounded-lg border border-line bg-raised px-3 py-2.5 text-xs leading-relaxed text-muted">
      Tap <span className="font-semibold text-body">Share</span> in the browser bar, then{" "}
      <span className="font-semibold text-body">Add to Home Screen</span>.
    </div>
  );
}

/** Install-to-home-screen control. Renders nothing once the app is already running standalone,
 *  or on a browser that offers neither a native prompt nor iOS's manual add-to-home-screen flow. */
export function InstallApp({ variant, iconsOnly }: { variant: "sidebar" | "login"; iconsOnly?: boolean }) {
  const { installed, canPrompt, promptInstall, isIos } = useInstallPrompt();
  const [showIosHint, setShowIosHint] = useState(false);

  if (installed || (!canPrompt && !isIos)) return null;

  const onClick = () => {
    if (canPrompt) promptInstall();
    else setShowIosHint((v) => !v);
  };

  if (variant === "login") {
    return (
      <div className="mt-5 border-t border-line pt-4">
        <button
          type="button"
          onClick={onClick}
          className="mx-auto flex items-center gap-2 text-sm font-medium text-muted transition hover:text-bright"
        >
          <DownloadIcon className="h-4 w-4 text-accent" />
          Install app
        </button>
        {showIosHint && <IosHint />}
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={onClick}
        title="Install app"
        className={`flex w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-left text-[15px] font-medium text-muted transition hover:bg-raised hover:text-body ${
          iconsOnly ? "justify-center px-0" : ""
        }`}
      >
        <DownloadIcon className="h-5 w-5" />
        {!iconsOnly && "Install app"}
      </button>
      {showIosHint && !iconsOnly && <IosHint />}
    </div>
  );
}
