import { useId, useState } from "react";
import { useInstallPrompt, type InstallPlatform } from "../hooks/useInstallPrompt";
import { useBrand } from "../useBrand";

function DownloadIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v13M7 11l5 5 5-5M4 21h16" />
    </svg>
  );
}

const ROUTE: Record<InstallPlatform, { steps: [string, string]; then: string }> = {
  ios: { steps: ["Share", "Add to Home Screen"], then: "It opens full screen with its own icon." },
  android: { steps: ["Browser menu (⋮)", "Add to Home screen"], then: "Some browsers call it Install app." },
  desktop: { steps: ["Install icon in the address bar", "Install"], then: "Or the browser menu → Install." },
  other: { steps: ["Browser menu", "Add to Home screen"], then: "Or Install, depending on the browser." },
};

function InstallHint({ id, platform }: { id: string; platform: InstallPlatform }) {
  const r = ROUTE[platform];
  return (
    <div id={id} role="note" className="rise mt-2.5 rounded-lg border border-line bg-raised px-3 py-2.5 text-xs leading-relaxed text-muted">
      Tap <span className="font-semibold text-body">{r.steps[0]}</span>, then <span className="font-semibold text-body">{r.steps[1]}</span>. {r.then}
    </div>
  );
}

/** Install-to-home-screen control. Hidden only once the app is already running
 *  standalone; where the browser offers no native prompt it explains that
 *  browser's own route instead of vanishing. */
export function InstallApp({ variant, iconsOnly }: { variant: "sidebar" | "login"; iconsOnly?: boolean }) {
  const { installed, canPrompt, promptInstall, platform } = useInstallPrompt();
  const brand = useBrand();
  const [showHint, setShowHint] = useState(false);
  const hintId = useId();

  if (installed) return null;
  const label = brand ? `Install ${brand}` : "Install app";
  const onClick = () => {
    if (canPrompt) void promptInstall();
    else setShowHint((v) => !v);
  };
  const aria = canPrompt ? {} : { "aria-expanded": showHint, "aria-controls": hintId };

  if (variant === "login") {
    return (
      <div className="mt-5 border-t border-line pt-4">
        <button type="button" onClick={onClick} {...aria} className="mx-auto flex items-center gap-2 text-sm font-medium text-muted transition hover:text-bright">
          <DownloadIcon className="h-4 w-4 text-accent" />
          {label}
        </button>
        {showHint && !canPrompt && <InstallHint id={hintId} platform={platform} />}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        {...aria}
        title={label}
        className={`flex w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-left text-[15px] font-medium text-muted transition hover:bg-raised hover:text-body ${
          iconsOnly ? "justify-center px-0" : ""
        }`}
      >
        <DownloadIcon className="h-5 w-5" />
        {!iconsOnly && label}
      </button>
      {showHint && !canPrompt && !iconsOnly && <InstallHint id={hintId} platform={platform} />}
    </div>
  );
}
