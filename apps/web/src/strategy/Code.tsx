import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type StrategySourceText, type StrategySourceVersion, type StrategySourceView } from "../api";
import { Icon, Loadable, Pill } from "../components/ui";
import { age, count, tsDay } from "../format";
import { useSearchParam } from "../router";
import { diffCounts, lineDiff, type DiffLine } from "./code/diff";
import { highlightQkt, type CodeToken } from "./code/highlight";
import ConfigurationSection from "./Configuration";
import { Widget } from "./widgets";
import { metaString } from "../portfolio";

/*
 * The strategy's code: the version running now, highlighted with qkt's own grammar, and every
 * earlier version qkt reported, each named by the sha256 of its file. qkt sends the text on
 * strategy.started once per process and version; a version this collector has no text for says
 * why. Admin only: no public route serves it (api publicView.ts).
 */

const NOT_SENT = "Source not sent by this qkt version. qkt reports a strategy's code on strategy.started from the release that added it; this one sent only the file's path and sha256.";
const NOT_RECEIVED = "Source not received for this version. qkt sends a strategy's code once per process and version, and this collector does not hold that copy: it never arrived, or the data was reset after it did. It is sent again the next time the qkt process restarts.";
const TRUNCATED = "qkt sends at most the first 64 KiB of a strategy file; the sha256 covers the whole file.";

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function withoutFinalNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** `lines` as highlighted tokens once the grammar has run; the plain lines until then. */
function useHighlighted(text: string | undefined): CodeToken[][] | null {
  const [lines, setLines] = useState<CodeToken[][] | null>(null);
  useEffect(() => {
    setLines(null);
    if (text == null) return;
    let live = true;
    highlightQkt(text).then((l) => live && setLines(l), () => live && setLines(null));
    return () => { live = false; };
  }, [text]);
  return lines;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-ctl bg-raised px-2.5 text-xs font-medium text-bright transition hover:bg-well"
      aria-label="Copy this version's code"
    >
      <Icon d="M8 8h11v13H8zM5 16H4V3h11v1" className="h-3.5 w-3.5" />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function Tokens({ tokens }: { tokens: CodeToken[] }) {
  return (
    <>
      {tokens.map((t, i) => (
        <span
          key={i}
          style={{ color: t.color, fontStyle: t.fontStyle && t.fontStyle & 1 ? "italic" : undefined, fontWeight: t.fontStyle && t.fontStyle & 2 ? 600 : undefined }}
        >
          {t.content}
        </span>
      ))}
    </>
  );
}

/**
 * The code block's classes: ligatures off, so `!=` and `>=` read as typed, not as `≠` and `≥`. Wrapped, a long
 * line continues under itself with a hanging indent; unwrapped it scrolls inside the block, never the page.
 */
function codeClasses(wrap: boolean) {
  return {
    pre: `${wrap ? "" : "min-w-max "}py-2 font-mono text-[12px] leading-5 [font-variant-ligatures:none]`,
    code: wrap ? "min-w-0 whitespace-pre-wrap break-words pl-[8ch] pr-4 -indent-[8ch]" : "pr-4",
  };
}

/** The code with a line-number gutter; long lines wrap under themselves or scroll inside the block ([codeClasses]). */
function CodeBlock({ text, wrap }: { text: string; wrap: boolean }) {
  const highlighted = useHighlighted(text);
  const plain = useMemo(() => text.split("\n"), [text]);
  const all = highlighted ?? plain.map((l) => [{ content: l }]);
  // the newline that ends the file opens no line of its own
  const lines = text.endsWith("\n") ? all.slice(0, -1) : all;
  const width = String(lines.length).length;
  const css = codeClasses(wrap);
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-ink">
      <pre className={css.pre} style={{ color: "var(--code-text)" }}>
        {lines.map((tokens, i) => (
          <div key={i} className="flex">
            <span className="sticky left-0 box-content shrink-0 select-none bg-ink pl-3 pr-4 text-right text-muted" style={{ width: `${width}ch` }} aria-hidden>{i + 1}</span>
            <code className={css.code}><Tokens tokens={tokens} /></code>
          </div>
        ))}
      </pre>
    </div>
  );
}

/** One version against the version before it: removed lines on red with "−", added on green with "+". */
function DiffBlock({ diff, wrap }: { diff: DiffLine[]; wrap: boolean }) {
  const css = codeClasses(wrap);
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-ink">
      <pre className={css.pre} style={{ color: "var(--code-text)" }}>
        {diff.map((d, i) => (
          <div key={i} className="flex" style={{ background: d.kind === "add" ? "var(--code-add)" : d.kind === "del" ? "var(--code-del)" : undefined }}>
            <span className="w-10 shrink-0 select-none pr-1 text-right text-muted" aria-hidden>{d.oldNo ?? ""}</span>
            <span className="w-10 shrink-0 select-none pr-2 text-right text-muted" aria-hidden>{d.newNo ?? ""}</span>
            <span className={`w-4 shrink-0 select-none ${d.kind === "add" ? "text-gain" : d.kind === "del" ? "text-loss" : "text-muted"}`}>
              {d.kind === "add" ? "+" : d.kind === "del" ? "−" : " "}
            </span>
            <code className={css.code}>{d.text}</code>
          </div>
        ))}
      </pre>
    </div>
  );
}

function useSourceText(instanceId: string, strategyId: string, version: StrategySourceVersion | undefined) {
  return useQuery({
    queryKey: ["strategy-source-text", instanceId, strategyId, version?.sha256],
    queryFn: () => get<StrategySourceText>(
      `/strategy-source/text?instance=${encodeURIComponent(instanceId)}&strategy=${encodeURIComponent(strategyId)}&sha=${encodeURIComponent(version!.sha256)}`,
    ),
    enabled: version?.text === "stored",
    staleTime: Infinity,
  });
}

/** Beside the code on a wide screen; above it on a narrow one, where the code would push it off the page. */
const CONFIG_CELL = "min-w-0 xl:col-start-2 xl:row-start-1";

function Missing({ children }: { children: string }) {
  return <p className="rounded-lg border border-line bg-raised px-4 py-6 text-sm text-muted">{children}</p>;
}

/** Path, sha and when the version ran: the facts that name the file qkt ran. */
function VersionFacts({ version, running }: { version: StrategySourceVersion; running: boolean }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[auto_1fr]">
      <dt className="text-muted">File</dt>
      <dd className="min-w-0 break-all font-mono text-xs text-bright">{version.path ?? "not stated"}</dd>
      <dt className="text-muted">sha256</dt>
      <dd className="min-w-0 break-all font-mono text-xs text-bright">{version.sha256}</dd>
      <dt className="text-muted">{running ? "Running since" : "First seen"}</dt>
      <dd className="text-bright">
        {tsDay(version.firstSeen)} UTC <span className="text-muted">· last start {age(version.lastSeen)} · {count(version.starts)} start{version.starts === 1 ? "" : "s"}</span>
      </dd>
    </dl>
  );
}

function VersionList({ versions, running, picked, onPick }: {
  versions: StrategySourceVersion[]; running: string | null; picked: string; onPick: (sha: string) => void;
}) {
  return (
    <ul className="grid gap-1" aria-label="Versions">
      {versions.map((v) => (
        <li key={v.sha256}>
          <button
            type="button"
            aria-current={v.sha256 === picked ? "true" : undefined}
            onClick={() => onPick(v.sha256)}
            className={`grid w-full grid-cols-[1fr_auto] items-baseline gap-x-2 rounded-lg border px-3 py-2 text-left transition ${
              v.sha256 === picked ? "border-accent-hi/50 bg-accent-soft" : "border-transparent hover:bg-hover"
            }`}
          >
            <span className="font-mono text-xs text-bright" title={v.sha256}>{shortSha(v.sha256)}</span>
            <span>{v.sha256 === running ? <span className="text-xs font-medium text-accent-ink">running</span> : v.text !== "stored" && <span className="text-xs text-muted">no text</span>}</span>
            <span className="col-span-2 text-xs text-muted">
              {tsDay(v.firstSeen).slice(0, 14)} UTC · {count(v.starts)} start{v.starts === 1 ? "" : "s"}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function CodeSection({ instanceId, strategyId, meta }: {
  instanceId: string; strategyId: string; meta: Record<string, unknown> | null;
}) {
  const sources = useQuery({
    queryKey: ["strategy-source", instanceId, strategyId],
    queryFn: () => get<StrategySourceView>(`/strategy-source?instance=${encodeURIComponent(instanceId)}&strategy=${encodeURIComponent(strategyId)}`),
    refetchInterval: 60_000,
  });
  const [asked, setAsked] = useSearchParam("v");
  const [compare, setCompare] = useState(false);
  const [wrap, setWrap] = useState(true);
  const versions = sources.data?.versions ?? [];
  const running = sources.data?.running ?? null;
  const index = Math.max(0, versions.findIndex((v) => v.sha256 === asked));
  const version = versions[index];
  const previous = versions.slice(index + 1).find((v) => v.text === "stored");
  const text = useSourceText(instanceId, strategyId, version);
  const before = useSourceText(instanceId, strategyId, compare ? previous : undefined);
  const diff = useMemo(
    () => (compare && text.data && before.data ? lineDiff(withoutFinalNewline(before.data.text), withoutFinalNewline(text.data.text)) : null),
    [compare, text.data, before.data],
  );
  const counts = diff ? diffCounts(diff) : null;

  return (
    <Loadable loading={sources.isPending} error={sources.isError} retry={() => sources.refetch()} what="the strategy's code" shape="lines" lines={10}>
      {versions.length === 0 || !version ? (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className={CONFIG_CELL}><ConfigurationSection instanceId={instanceId} strategyId={strategyId} /></div>
        <Widget title="Source" className="xl:col-start-1 xl:row-start-1">
          {metaString(meta, "sourceSha256") || metaString(meta, "sourcePath") ? (
            <div className="grid gap-3">
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[auto_1fr]">
                <dt className="text-muted">File</dt>
                <dd className="break-all font-mono text-xs text-bright">{metaString(meta, "sourcePath") ?? "not stated"}</dd>
                <dt className="text-muted">sha256</dt>
                <dd className="break-all font-mono text-xs text-bright">{metaString(meta, "sourceSha256") ?? "not stated"}</dd>
              </dl>
              <Missing>{NOT_SENT}</Missing>
            </div>
          ) : (
            <Missing>No start reported yet. The code arrives with the strategy's next strategy.started from qkt.</Missing>
          )}
        </Widget>
        </div>
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px] xl:grid-rows-[auto_1fr]">
          <div className={CONFIG_CELL}><ConfigurationSection instanceId={instanceId} strategyId={strategyId} /></div>
          <Widget
            className="xl:col-start-1 xl:row-span-2 xl:row-start-1"
            title={version.sha256 === running ? "Running version" : `Version ${shortSha(version.sha256)}`}
            hint={version.sha256 === running ? undefined : "an earlier version, not the one running"}
          >
            <div className="grid gap-3">
              <VersionFacts version={version} running={version.sha256 === running} />
              {version.text === "stored" && (
                <div className="flex flex-wrap items-center gap-2">
                  {version.truncated && <span title={TRUNCATED}><Pill tone="warn">first 64 KiB of the file</Pill></span>}
                  {previous && (
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted">
                      <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} className="accent-[var(--color-accent)]" />
                      Changes since {shortSha(previous.sha256)}
                      {counts && <span className="font-mono text-xs"><span className="text-gain">+{counts.added}</span> <span className="text-loss">−{counts.removed}</span></span>}
                    </label>
                  )}
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted">
                    <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} className="accent-[var(--color-accent)]" />
                    Wrap lines
                  </label>
                  <span className="ml-auto">{text.data && <CopyButton text={text.data.text} />}</span>
                </div>
              )}
              {version.text === "not-sent" && <Missing>{NOT_SENT}</Missing>}
              {version.text === "not-received" && <Missing>{NOT_RECEIVED}</Missing>}
              {version.text === "stored" && (
                <Loadable loading={text.isPending} error={text.isError} retry={() => text.refetch()} what="this version's code" shape="lines" lines={12}>
                  {compare && diff ? <DiffBlock diff={diff} wrap={wrap} /> : compare && before.data && !diff ? (
                    <Missing>These two versions are too long to compare here.</Missing>
                  ) : text.data ? <CodeBlock text={text.data.text} wrap={wrap} /> : null}
                </Loadable>
              )}
            </div>
          </Widget>
          <Widget className="xl:col-start-2" title={`${versions.length} version${versions.length === 1 ? "" : "s"}`} hint="newest first">
            <VersionList
              versions={versions}
              running={running}
              picked={version.sha256}
              onPick={(sha) => {
                setCompare(false);
                setAsked(sha === running ? "" : sha);
              }}
            />
          </Widget>
        </div>
      )}
    </Loadable>
  );
}
