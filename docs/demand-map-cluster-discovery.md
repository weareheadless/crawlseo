# Demand map: cluster discovery (wave 5)

Status: **proposed spec**, implemented alongside this document.
Depends on: `docs/seo-funnel-spine-plan.md` §2.1 (the demand map) and §3 (the opportunity taxonomy).
Owner decisions it applies: clean funnel, automatic detection, human decisions, business research is a first-class evidence source.

## 1. Problem

`DemandMapCluster` exists and the projection reads it, but nothing discovers clusters. Production holds 0 clusters and the demand map says so. Opportunities work unclustered, so this is enrichment — but without clusters the map cannot answer "which needs do we cover", the cluster play cannot fire, and topical authority has nowhere to live.

The hard part is not grouping queries once. It is doing it repeatedly without forking the map: every re-run must land on the same clusters, or opportunities end up pointing at dead ones.

## 2. Signals

Four signals propose clusters. Each proposal carries the evidence that produced it, so a cluster can always explain itself.

| Signal | Input | Strength | Available |
|---|---|---|---|
| `gsc_query` | Search Console queries (first-party, already stored) | lexical grouping by shared phrase | now |
| `serp_overlap` | stored SERP snapshots with top-URL lists | queries sharing results address the same need | when SERP evidence lands (DS-05) |
| `knowledge_prior` | canonical business facts and the questions customers ask | intended need, top-down | now, when knowledge exists |
| `competitor_ownership` | queries where competitors hold the top results and we are absent | demand we do not serve | when competitor ranks land |

Signals are additive. A cluster may be proposed by one and later corroborated by another; corroboration raises confidence and is recorded, never silently replaces the origin.

### 2.1 `gsc_query` — lexical grouping

1. Take the latest observation per query from `keyword_rank` evidence.
2. Normalise: lowercase, strip accents and punctuation.
3. Drop stopwords (English and Spanish) and tokens shorter than three characters.
4. Generate adjacent significant-token bigrams. A bigram is a candidate cluster key.
5. Group queries by shared bigram. Keep groups with at least `minMembers` queries.
6. Merge groups that share queries (connected components), so "freediving course playa" and "freediving course bacalar" become one cluster rather than two.
7. Cluster name = the bigram with the most members; identity = that bigram.

This is a declared heuristic, not a model. It is auditable: every member is a stored query, and the shared phrase is the stated reason.

### 2.2 `serp_overlap` — the objective backbone

Two queries whose top-10 results share at least `overlapThreshold` of the same URLs address the same need, whatever the wording. Cluster = connected component of queries above the pairwise threshold. Identity = the query with the most overlaps (the hub).

Preferred over lexical grouping when both exist, because it is observed rather than inferred.

### 2.3 `knowledge_prior` — the top-down prior

Each question in canonical business knowledge becomes a candidate cluster of one, with the question as its topic summary. It records *intent*, and stays `relevance: none` until demand validates it or a person endorses it. This is the "why" leg applied to the map: without it the map fills with queries nobody should chase.

### 2.4 `competitor_ownership`

Queries where every top result is a competitor and we hold none. Feeds O3 (content gap) and O9 (authority gap). Same identity rules as `serp_overlap`.

## 3. Identity and reconciliation

A cluster's identity is **derived from its members, never from its display name**. Names change when a better phrase wins; identity must not.

- `identityKey` is unique per project: `lexical:<bigram>`, `serp:<hub query>`, `knowledge:<question hash>`.
- A proposal first tries to match an existing cluster by **member overlap** (Jaccard ≥ `mergeThreshold`). On a match it merges: members are added, confidence is raised, the origin signal is recorded. On no match it creates a cluster.
- Matching by overlap means a re-run that phrases the cluster differently still lands on the same row.
- A cluster that ends a reconciliation with no active members is **superseded**, never deleted (`supersededById`), and its opportunities keep their link.

Reconciliation is idempotent: the same evidence run twice produces no new clusters and no new membership records.

## 4. Curation gate

Unchanged from the spine plan, and now enforced for machine proposals:

- A machine-proposed cluster is born with `businessRelevance.relevance = "none"` and `proposedBy = <signal>`.
- Marking a cluster `core` or `adjacent` requires `decidedBy`. Discovery never endorses.
- The demand map shows both, and says which is which.

## 5. Membership evidence

Every (cluster, query) pair is recorded as `keyword_universe_membership` evidence with dimensions `{ cluster: <slug>, query, source, volume? }` and the observation time taken from the underlying data, not from the run — that is what makes re-runs idempotent.

This is the store `recomputeDemandMap` and the cluster play already read, so coverage, share of voice and cluster-play detection start working the moment clusters exist.

## 6. Data model

`DemandMapCluster` gains:

| Field | Purpose |
|---|---|
| `identityKey` | stable identity, unique per project |
| `proposedBy` | the signal that proposed it |
| `confidence` | 0–1, raised by corroborating signals |
| `supersededById` | supersede, never delete |

## 7. UI

- **Demand map** lists clusters with member count, coverage, our best position, and open opportunities; a cluster links to its own page.
- **Cluster page** (`/sites/<id>/demand/<clusterId>`) shows the reason it exists (signal, shared phrase or hub query, when), its members with volume and our position, its coverage, and the opportunities inside it.
- Unclustered opportunities stay stated explicitly.

## 8. Acceptance

- Discovery from GSC data produces clusters on a real project with no spend.
- Re-running discovery twice creates zero duplicate clusters and zero duplicate membership records.
- A cluster proposed with a different name but the same members merges into the existing row.
- A cluster whose members disappear is superseded, and its opportunities still resolve.
- Machine-proposed clusters carry `relevance: none` and no `decidedBy`.
- Cluster plays fire for an under-covered cluster with enough members.
- Unit tests cover identity, merge, supersede, lexical grouping, SERP overlap, membership idempotency and the curation gate.

## 8a. Known limitation, measured on live data

Clusters built from the `gsc_query` signal are, by construction, clusters we
already rank for — every member came from a rank observation. Live coverage is
therefore 1.0 for every such cluster, and the cluster play (which fires only
when coverage is low) correctly does not fire.

This is not a defect, it is the boundary of the signal. Clusters that can
produce a topical-authority play need demand we do **not** serve yet, which
requires the universe-expansion and competitor-ownership signals (DataForSEO
keywords and competitor ranks). Until those land, the demand map answers "what
needs do we cover and how well", not "what should we enter".

## 9. Non-goals

- No paid provider calls. Discovery reads stored evidence only.
- No LLM naming in this wave. Names come from the members (shared phrase or hub query) so they are reproducible.
- No automatic endorsement of a cluster.
- No deletion of anything.
