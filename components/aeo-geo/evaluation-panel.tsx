import Link from "next/link";
import type { EvaluationVerdict, SurfaceProjection } from "@/lib/aeo/surface";

const labels: Record<EvaluationVerdict, string> = {
  not_asked: "Not asked yet", no_observation: "No observation yet", answer_absent: "No AI answer returned", brand_absent: "Brand absent",
  brand_present: "Brand present", no_brand_mention: "Answer returned; no brand mention extracted", failed: "Request failed", over_budget: "Over budget",
};

export function EvaluationPanel({ siteId, version, locale, askedAt, emptyReason, questions, runs, competitorDomains }: {
  siteId: string;
  version: string | null;
  locale: string | null;
  askedAt: Date | null;
  emptyReason: string | null;
  questions: Array<{ question: string; questionSetVersion: string; origin: "generated" | "earlier"; surfaces: SurfaceProjection[] }>;
  runs: Array<{ runId: string; status: string; failed: number; skippedByCap: number; startedAt: Date; questionSetVersion: string }>;
  competitorDomains: string[];
}) {
  return <section className="panel p-4 sm:p-5" aria-labelledby="evaluation-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="evaluation-title" className="font-heading text-lg font-semibold">Questions asked · {questions.length}</h2>
        <p className="mt-1 text-sm text-muted-foreground">Actual prompts and saved answers from read-only evaluation observations.</p></div>
      <Link className="text-sm text-primary underline underline-offset-2" href={`/sites/${siteId}/aeo-geo?tab=identity`}>AEO crawl &amp; identity evidence</Link>
    </div>
    <p className="mt-3 text-xs text-muted-foreground">Question set {version ?? "not recorded"} · locale {locale ?? "not recorded"} · last asked {askedAt?.toLocaleString() ?? "not yet"}</p>
    {emptyReason === "no_business_data" && questions.length > 0 && <p className="mt-3 rounded-lg bg-muted/30 p-3 text-sm">No current questions can be generated because business knowledge, profile data, and research inputs are missing. Historical questions below are from earlier sets.</p>}
    {runs.some((run) => run.failed || run.skippedByCap) && <p className="mt-3 rounded-lg bg-warning/10 p-3 text-sm" role="status">
      Run outcomes (not observations): {runs.filter((r) => r.failed).reduce((n,r) => n+r.failed,0)} provider request(s) failed, rate-limited, or over budget; {runs.filter((r) => r.skippedByCap).reduce((n,r) => n+r.skippedByCap,0)} request(s) were not attempted because the run cap was reached. These totals cannot be attributed to an individual question or surface; no answer or citation is inferred.
    </p>}
    {questions.length === 0 ? <p className="mt-4 rounded-lg bg-muted/30 p-4 text-sm">{emptyReason === "no_business_data" ? "No questions can be generated because business knowledge, profile data, and research inputs are missing. Add accepted business knowledge or profile inputs to preview questions before running an evaluation." : "No questions are available yet. Crawl and identity evidence below is technical evidence, not proof of AI answer visibility."}</p> :
      <div className="mt-4 space-y-4">{questions.map(({ question, questionSetVersion, origin, surfaces }) => <article key={`${question}:${questionSetVersion}`} className="rounded-lg border border-border/60 p-3">
        <h3 className="font-medium">{question}{origin === "earlier" && <span className="ml-2 text-xs font-normal text-muted-foreground">From an earlier question set</span>}</h3><p className="mt-1 text-xs text-muted-foreground">Question set {questionSetVersion} · locale {locale ?? "not recorded"}</p><div className="mt-3 grid gap-3 lg:grid-cols-2">{surfaces.map((item) => <section key={item.surface} className="rounded-md bg-muted/20 p-3" aria-label={item.surface === "perplexity_api" ? "Perplexity answer evidence" : "Google AI Overview answer evidence"}>
          <h4 className="text-sm font-semibold">{item.surface === "perplexity_api" ? "Perplexity" : "Google AI Overview"}</h4>
          <p className="mt-1 text-sm">{labels[item.verdict]}</p>
          {item.verdict === "not_asked" && <p className="mt-1 text-xs text-muted-foreground">Would be asked with question set {questionSetVersion} in locale {locale ?? "not recorded"}. No request has been made; no citations are available.</p>}
          {item.observation && <p className="mt-1 text-xs text-muted-foreground">Asked {item.observation.observedAt.toLocaleString()} · locale {item.observation.locale ?? "unknown"} · set {item.observation.questionSetVersion}</p>}
          {item.answerExcerpt ? <blockquote className="mt-2 border-l-2 border-border pl-3 text-sm">{item.answerExcerpt}{item.observation?.answerText && item.observation.answerText.length > item.answerExcerpt.length ? "…" : ""}</blockquote> : <p className="mt-2 text-sm text-muted-foreground">No answer excerpt was returned for this state.</p>}
          {item.observation && <>
            <p className="mt-2 text-xs font-medium">Cited URLs</p>{item.citedUrls.length ? <ul className="mt-1 list-inside list-disc space-y-1 text-xs">{item.citedUrls.map((url) => <li key={url} className="break-all"><a className="text-primary underline" href={url} target="_blank" rel="noreferrer">{url}</a></li>)}</ul> : <p className="mt-1 text-xs text-muted-foreground">No citations recorded.</p>}
            <p className="mt-2 text-xs">Cited domains: {item.citedDomains.join(", ") || "none recorded"}{item.citationsTruncated ? ` · list limited to ${item.citedUrls.length} (truncated)` : ""}</p>
            <p className="mt-1 text-xs">Domain citation frequency: {item.citedDomainsFrequency.map((entry) => `${entry.domain} (${entry.count})`).join(", ") || "none"}</p>
            <p className="mt-1 text-xs">Competitor/source overlap: {item.competitorOverlapCount}{item.competitorDomains.length ? ` · ${item.competitorDomains.join(", ")}` : ""}</p>
          </>}
          {item.diff && <p className="mt-1 text-xs">Same-set run diff: {item.diff.answerChanged ? "answer changed" : "answer unchanged"}; citations added [{item.diff.citationAdded.join(", ") || "none"}], removed [{item.diff.citationRemoved.join(", ") || "none"}].</p>}
        </section>)}</div>
        {surfaces.some((surface) => surface.observation) && <section className="mt-3 rounded-md bg-muted/20 p-3"><h4 className="text-sm font-semibold">GEO · sources selected instead</h4>
          <p className="mt-1 text-sm">{surfaces.map((s) => s.competitorDomains).flat().filter((d,i,a)=>a.indexOf(d)===i).join(", ") || "No competitor domains in these citations."} · competitor overlap across surfaces: {surfaces.reduce((n,s)=>n+s.competitorOverlapCount,0)}</p>
          {competitorDomains.length === 0 && <p className="mt-1 text-xs text-muted-foreground">No competitor URLs are configured for overlap comparison.</p>}
        </section>}
      </article>)}</div>}
  </section>;
}
