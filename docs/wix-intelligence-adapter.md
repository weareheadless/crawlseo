# Wix intelligence adapter qualification

Status: engineering contract only. No Wix tenant was contacted for this work. The Wix binding stays unavailable until a separately authorized disposable pilot passes every gate below.

## Negotiated operation contract

`lib/bridge/client.ts` accepts an operation only when a bridge response explicitly contains `capabilities.<operation> === true`. Missing, malformed, or unknown capability data means unsupported. The operation names are `inspect`, `plan`, `deploy`, `publish`, `release`, `verify`, `read_embed`, `write_embed`, `cms`, and `seo_tags`. Support is independent per operation: embed write permission does not imply code publish, CMS, or SEO tag support.

The reviewed generic Wix Bridge v1 inventory supports inspection, planning, deploy, verify, and configured embed reads. Its CLI does not support CrawlSEO's `update-snippet --preserve-scope` or `release --non-interactive` requests. Generic bridge publication requires a local terminal; the host checkout's parser-only `--non-interactive` flag is not publication authorization. The existing explicitly configured host callers remain legacy paths; they are not evidence that generic-main negotiated the same feature set. Do not enable an intelligence binding on absent or mismatched capability declarations.

Blog remains a separate existing content adapter. CMS writes, native Editor changes, and SEO tag operations are unsupported. Do not route them through embed updates or code publication.

## Embed apply boundary

An embed plan records the Action revision, task and reviewed commit, connector binding generation, alias, target key, configured snippet, component and source path, plus source/current/desired SHA-256 values. Its confirmation is a digest of those exact inputs. Apply requires that confirmation, a clean reviewed source at the recorded commit, the same Action revision and binding generation, and unchanged live embed content. A changed input requires a fresh plan.

Before the write, the adapter stores an apply-started artifact. The returned bridge value alone does not mark a task published: the adapter reads the configured snippet back and requires the planned desired hash. A lost response, partial receipt, or mismatched/unavailable readback leaves an unknown or partial receipt and prevents retry. Reconciliation reads the same configured snippet; a matching desired hash records the recovered result, while any other state remains blocked for operator review. It never repeats an uncertain write automatically.

Code publication remains separate from embed apply. Existing Wix revision checks and explicit approved task release callers remain in place. Generic bridge `release` is unsupported unless negotiated, and combined code-publish-plus-embed workflows are not atomic. A process crash can still interrupt between an external Wix effect and its local receipt; the pilot must verify recovery behavior for that window.

## Disposable pilot gates

Only after separate owner authorization, use a disposable Wix site and a target created for the pilot. Record evidence for each gate before enabling a Wix binding:

1. Verify credentials are site-scoped and limited to the documented Custom Embeds API scope; verify exact manifest alias, site ID, configured snippet, placement, page scope, and connector generation.
2. Negotiate capabilities from the tested bridge build. Exercise supported inspection, plan, read, and one immediately-live embed write. Confirm unsupported Editor, CMS, SEO tag, and generic release operations fail closed.
3. Prove confirmation invalidation for changed Action revision, source commit/content, alias, snippet, page/placement scope, live embed hash, and binding generation.
4. Inject stale revision, partial write, lost response, process interruption, and readback mismatch. Preserve per-effect evidence and confirm no blind retry occurs; prove exact-hash reconciliation before any operator-authorized retry.
5. Independently validate the published embed's rendered behavior and the distinct code publication path. API hash equality alone is not visual or functional verification.
6. Have the owner review the evidence and separately authorize a binding change. Until then, keep Wix capability disabled.

This document and the fake-client tests are not a live pilot, Wix API certification, or authorization to choose a customer target or publish a site.
