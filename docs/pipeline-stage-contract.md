# Pipeline stage contract

`lib/pipeline/stages.ts` is the pure, data-independent contract for the product sequence: **Business → Research → Findings → Work → Results**. The exported `PIPELINE_STAGES` tuple is the stable source of stage IDs, labels, entry URLs, owners, upstream inputs and downstream outputs. `PipelineStageId` and `PipelineStage` are the consumer types. The overview is the site root and Settings is `/settings`; neither is a stage.

Consumers should use `buildStageUrl(siteId, stageId, optionalNestedPath)` for site-local links, `resolvePipelineStage(pathname)` to identify a stage from nested routes, and `PipelineNavigation` / `PipelineStageContext` from `components/pipeline/pipeline-navigation.tsx` for navigation and page context. `aria-current="step"` identifies the active destination. The components render no progress/completion state and do not query live data. Callers retain responsibility for authorization and site existence.

Legacy detail lenses map explicitly: `keyword-research` → Research; `crawl` and `aeo-geo` → Findings; `content-studio` → Work. They are context lenses, not additional stages. Business has no inferred completion from its route. Overview and settings remain outside stage resolution.

The sequence describes connected evidence and work, not a guaranteed linear job. Stages can overlap, retry, or be absent. Inputs/outputs are descriptive contracts; consumers must show actual recorded evidence and blockers and must not infer completion, provenance, execution or outcomes from route position. AEO/GEO are dimensions of findings/work/results, not queues. This contract introduces no data reads or mutations.
