# pi-agent Literature Research Extension Plan

本文给出在 pi 上扩展 `literature-research` 能力的实现方案。目标不是把 pi-agent 改造成一个通用论文搜索网站，而是为现有实验研究流程增加可审计的文献检索、论文阅读、证据抽取和证据驱动实验规划能力。

## Goals

- 让 agent 能围绕研究目标查找论文、导入论文、阅读全文或摘要、抽取结构化证据。
- 所有文献结论必须可追溯到 paper metadata、DOI/arXiv/PubMed/OpenAlex/Semantic Scholar id、query snapshot、section/page/chunk 和引用。
- 将文献证据接入 `.pi/extensions/experiment-research` 的 `plan_next_experiment`，让下一轮实验规划显式引用证据。
- 支持 local-first 记录，避免每次重新搜索导致不可复现。
- 首版优先支持 metadata search、abstract/full-text ingestion、evidence table，不先实现完整多 agent 写论文系统。

## Non-Goals

- 不把文献能力写进 pi-agent core。
- 不直接复制一个完整外部 research agent 项目。
- 不把无引用的自然语言摘要作为实验决策依据。
- 不绕过版权和访问限制批量抓取 paywalled PDF。
- 不让 literature extension 直接启动硬件实验；它只提供 evidence，实验执行仍由 `experiment-research` 的 policy/preflight/kernel 控制。

## Reference Projects

这些项目适合作为设计参考，而不是直接嵌入 pi：

| Project | Useful Ideas | Notes |
| --- | --- | --- |
| PaperQA2 / FutureHouse `paper-qa` | literature QA、citation graph traversal、grounded answers | 适合参考 agent tool loop 和 cited answer 约束 |
| Ai2 Asta Paper Finder | query decomposition、citation chasing、relevance evaluation | 适合参考“像研究员一样找论文”的 search strategy |
| OpenResearcher | arXiv corpus、Qdrant/Elasticsearch retrieval、RAG eval | 适合参考 retrieval backend 和 benchmark |
| Open Synthesis | multi-source ingestion、DOI dedupe、BM25+dense hybrid retrieval、rerank | 适合参考 evidence synthesis pipeline |
| OpenScholar | large open-access datastore、citation-backed synthesis | 适合参考 passage-level citation answer |
| Search Papers MCP | arXiv-focused MCP tools、citation network、bibliography export | 适合参考 agent-facing tool API 和 MCP 集成 |
| AutoResearchClaw | idea-to-paper staged pipeline | 只参考阶段划分，不建议首版复制 |
| Zotero | local reference manager、BibTeX、PDF library | 适合作为本地 paper source 和引用管理入口 |

## Architecture

推荐新建 project-local extension：

```text
.pi/extensions/literature-research/
  index.ts
  prompt.ts
  schemas.ts
  dispatch.ts
  sources/
    openalex.ts
    crossref.ts
    semantic-scholar.ts
    arxiv.ts
    pubmed.ts
    zotero.ts
  pdf/
    parser.ts
    chunker.ts
  retrieval/
    lexical.ts
    vector.ts
    rerank.ts
  store/
    library-store.ts
    evidence-store.ts
  tools/
    search-literature.ts
    import-paper.ts
    read-paper.ts
    extract-evidence.ts
    build-literature-review.ts
    link-evidence-to-experiment.ts
```

文献 extension 与实验 extension 的关系：

```text
research objective
  -> search_literature
  -> import_paper
  -> read_paper
  -> extract_evidence
  -> build_literature_review
  -> link_evidence_to_experiment
  -> experiment-research.plan_next_experiment(reviewId/evidenceIds)
  -> bounded ExperimentSpec
```

## Storage Layout

文献状态保存在 `.pi/literature/`，实验状态仍保存在 `.pi/experiment-runs/`。

```text
.pi/literature/
  library.json
  searches/
    <search-id>.json
  papers/
    <paper-id>/
      metadata.json
      source-records.jsonl
      fulltext.txt
      chunks.jsonl
      claims.jsonl
      annotations.jsonl
  reviews/
    <review-id>.json
    <review-id>.md
  evidence/
    evidence.jsonl
    evidence-links.jsonl
  references.bib
```

Key rules:

- `library.json` is the local paper registry.
- `searches/<search-id>.json` stores query, source, filters, returned ids, ranking, timestamp, and tool version.
- `metadata.json` stores canonical metadata plus raw source ids.
- `chunks.jsonl` stores retrievable text chunks with section/page offsets when available.
- `claims.jsonl` stores extracted structured claims.
- `evidence-links.jsonl` links claims/reviews to `experimentId`, `runId`, `specId`, or `decisionId`.
- `references.bib` is generated from metadata, not hand-written by the model.

## Core Schemas

### PaperRecord

```ts
interface PaperRecord {
  paperId: string;
  title: string;
  authors: Array<{ name: string; orcid?: string }>;
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  pubmedId?: string;
  openAlexId?: string;
  semanticScholarId?: string;
  url?: string;
  sourceIds: Record<string, string>;
  abstract?: string;
  fullTextStatus: "available" | "abstract_only" | "paywalled" | "missing" | "blocked";
  importedAt: string;
  updatedAt: string;
}
```

### SearchRecord

```ts
interface SearchRecord {
  searchId: string;
  query: string;
  expandedQueries: string[];
  sources: string[];
  filters: {
    fromYear?: number;
    toYear?: number;
    fields?: string[];
    openAccessOnly?: boolean;
  };
  resultPaperIds: string[];
  rawResultRefs: Array<{ source: string; id: string; rank: number }>;
  createdAt: string;
}
```

### EvidenceClaim

```ts
interface EvidenceClaim {
  evidenceId: string;
  paperId: string;
  claim: string;
  evidenceType: "measurement" | "method" | "theory" | "review" | "negative_result" | "limitation";
  materialSystem?: string;
  method?: string;
  metric?: string;
  value?: string;
  units?: string;
  limitation?: string;
  citation: {
    title: string;
    doi?: string;
    url?: string;
    section?: string;
    page?: number;
    chunkId?: string;
    quote?: string;
  };
  confidence: "low" | "medium" | "high";
  extractionMethod: "abstract" | "fulltext" | "manual" | "zotero_note";
  createdAt: string;
}
```

### LiteratureReview

```ts
interface LiteratureReview {
  reviewId: string;
  topic: string;
  objective?: string;
  searchIds: string[];
  paperIds: string[];
  evidenceIds: string[];
  synthesis: string;
  conflicts: Array<{ evidenceIds: string[]; summary: string }>;
  gaps: Array<{ summary: string; suggestedExperiment?: string }>;
  limitations: string[];
  createdAt: string;
}
```

## Tool Design

Only macro tools should be exposed to the planner.

### `search_literature`

Purpose: find candidate papers from configured sources.

Input:

```ts
{
  query: string;
  sources?: Array<"openalex" | "crossref" | "semantic_scholar" | "arxiv" | "pubmed" | "zotero">;
  maxResults?: number;
  fromYear?: number;
  toYear?: number;
  openAccessOnly?: boolean;
}
```

Output:

- `searchId`
- ranked `PaperRecord[]`
- source coverage summary
- deduplication summary
- `nextActions`

### `import_paper`

Purpose: create or update a local `PaperRecord`, optionally fetch legal full text.

Input:

```ts
{
  paperRef: {
    doi?: string;
    arxivId?: string;
    pubmedId?: string;
    openAlexId?: string;
    semanticScholarId?: string;
    zoteroKey?: string;
    localPdfPath?: string;
  };
  fetchFullText?: boolean;
}
```

Rules:

- Open-access full text may be fetched when source terms allow it.
- Paywalled papers must return `fullTextStatus = "paywalled"` and manual access hints.
- Local PDF paths are allowed if the user already has access.

### `read_paper`

Purpose: answer a focused question about one or more imported papers.

Input:

```ts
{
  paperIds: string[];
  question: string;
  sections?: string[];
  requireQuotes?: boolean;
}
```

Output must include cited passages or state that only abstract-level evidence was available.

### `extract_evidence`

Purpose: transform paper text into structured claims.

Input:

```ts
{
  paperIds: string[];
  extractionSchema?: "experiment_method" | "materials_property" | "limitation" | "generic_claim";
  objective?: string;
}
```

Output:

- `evidenceIds`
- extraction coverage
- confidence distribution
- rejected/uncertain claim count

### `build_literature_review`

Purpose: synthesize evidence across papers.

Input:

```ts
{
  topic: string;
  paperIds?: string[];
  evidenceIds?: string[];
  searchId?: string;
  reviewType?: "brief" | "related_work" | "evidence_table" | "gap_analysis";
}
```

Output:

- `reviewId`
- citation-backed synthesis
- evidence table
- conflicts
- gaps
- limitations

### `link_evidence_to_experiment`

Purpose: connect literature evidence to experiment records.

Input:

```ts
{
  experimentId?: string;
  runId?: string;
  specId?: string;
  decisionId?: string;
  evidenceIds?: string[];
  reviewId?: string;
  rationale: string;
}
```

Output:

- link records written to `.pi/literature/evidence/evidence-links.jsonl`
- summary suitable for `plan_next_experiment`

## Integration With Experiment Research

`experiment-research` should not import literature internals directly. Use explicit IDs:

```ts
interface PlanNextExperimentParams {
  runId: string;
  objective: string;
  evidenceIds?: string[];
  reviewId?: string;
}
```

`plan_next_experiment` should:

- load linked evidence summaries through a narrow reader API;
- reject missing `evidenceIds/reviewId` when the user asks for literature-backed planning;
- record evidence refs into `lineage.jsonl` and `decisions.jsonl`;
- never treat literature evidence as approval for hardware execution.

Suggested lineage addition:

```ts
interface LiteratureInputRef {
  reviewId?: string;
  evidenceIds: string[];
  searchIds: string[];
  paperIds: string[];
}
```

## Prompt Policy

The extension should inject a short prompt in `before_agent_start`:

- Claims about literature require citations.
- Abstract-only evidence must be marked as lower confidence unless the claim is directly in the abstract.
- Conflicting results must be reported, not averaged away.
- Missing full text must be reported.
- Paywalled content must not be fabricated.
- Literature evidence can inform `ExperimentSpec`, but cannot bypass `validate_experiment_spec`, `run_preflight`, operator approval, or hardware gates.

## Retrieval Strategy

Phase 1 should use source APIs and local lexical search only:

```text
metadata search -> dedupe -> rank -> import abstracts/full text -> chunk -> local lexical retrieval
```

Phase 2 can add vector search:

```text
chunk embeddings -> dense retrieval -> BM25 -> reciprocal rank fusion -> rerank -> cited answer
```

Do not add a vector database until there is enough local full text to justify it. A local JSONL + SQLite/BM25 store is easier to inspect and debug.

## Source Adapters

Start with adapters that can run without paid APIs:

- OpenAlex: broad metadata, DOI and citation graph support.
- Crossref: DOI metadata fallback.
- arXiv: preprints and source PDFs.
- PubMed: biomedical metadata.
- Zotero: local user library, PDFs, notes, BibTeX.

Then add optional adapters:

- Semantic Scholar: ranking, citations, paper recommendations. API key may improve reliability.
- OpenReview: ML conference papers.
- Europe PMC: biomedical full text and grants.

Each adapter should return a normalized `SourcePaperCandidate` and raw source payload for audit.

## Safety, Copyright, and Provenance

- Never store or expose full copyrighted articles acquired without user-provided lawful access.
- Avoid long verbatim excerpts in agent answers. Store short quotes only when needed for evidence traceability.
- Keep every generated claim attached to a citation object.
- Keep search snapshots so future runs can reproduce why a paper was selected.
- Mark source quality: peer-reviewed, preprint, review, dataset, benchmark, retracted/flagged when known.
- If a paper is retracted or has an expression of concern, surface that in `PaperRecord`.

## Implementation Phases

### Phase 0: Contract Spike

Goal: prove extension loading, tool registration, schemas, and local store.

- Create `.pi/extensions/literature-research`.
- Add `schemas.ts` for `PaperRecord`, `SearchRecord`, `EvidenceClaim`, `LiteratureReview`, and `ToolResult`.
- Register read-only tools: `search_literature`, `import_paper`, `read_paper`.
- Implement a local fake source adapter for tests.
- Write `.pi/literature/library.json` and `searches/<search-id>.json`.
- Add extension tests for tool registration and prompt injection.

Exit criteria:

- Extension loads from `.pi/extensions/literature-research`.
- Tools are visible in active tools.
- Fake search creates deterministic search and paper records.

### Phase 1: Real Metadata Search

Goal: search real metadata sources and dedupe papers.

- Add OpenAlex, Crossref, arXiv, PubMed adapters.
- Normalize identifiers and dedupe by DOI/arXiv/PubMed/OpenAlex/Semantic Scholar ids.
- Persist raw source records for audit.
- Export `references.bib`.
- Add rate-limit and retry handling.

Exit criteria:

- A query can produce a ranked, deduped paper set with stable `paperId`s.
- No full-text parsing is required yet.

### Phase 2: Paper Reading and Evidence Extraction

Goal: turn papers into cited claims.

- Add local PDF/text import path.
- Add open-access full-text fetch where legal and source-supported.
- Add chunking with section/page/chunk ids.
- Implement `read_paper`.
- Implement `extract_evidence`.
- Store `claims.jsonl` and global `evidence.jsonl`.

Exit criteria:

- Agent can answer paper-specific questions with chunk/page citations.
- Evidence claims are structured and linked to paper records.

### Phase 3: Literature Review and Experiment Linkage

Goal: connect literature synthesis to experiment planning.

- Implement `build_literature_review`.
- Implement `link_evidence_to_experiment`.
- Extend `experiment-research` `PlanNextExperimentParams` with `evidenceIds` and `reviewId`.
- Write literature refs into experiment lineage and decision audit.
- Add tests for missing evidence, stale evidence, and evidence-backed plan creation.

Exit criteria:

- `plan_next_experiment` can cite review/evidence refs.
- Experiment lineage contains paper/evidence provenance.

### Phase 4: Retrieval Quality Improvements

Goal: improve recall and synthesis quality without changing public contracts.

- Add local BM25/SQLite index.
- Add optional embeddings and vector search.
- Add hybrid retrieval and reranking.
- Add citation graph expansion from seed papers.
- Add contradiction/gap extraction.

Exit criteria:

- The same public tools produce better ranked evidence and reviews.
- The storage schema remains backward compatible only if explicitly required by users; otherwise migrate records.

### Phase 5: Productization

Goal: make the extension reusable outside this repo.

- Extract stable code into `packages/literature-agent` only after extension contracts stabilize.
- Add configuration for enabled sources, API keys, cache policy, and storage path.
- Add docs for Zotero, local PDFs, and citation export.
- Add focused tests and lightweight fixture corpora.

## Testing Strategy

- Schema tests: malformed paper/search/evidence/review records are rejected.
- Source adapter tests: normalize sample OpenAlex/Crossref/arXiv/PubMed payloads.
- Dedupe tests: DOI/arXiv/PubMed aliases resolve to one `paperId`.
- Store tests: append-only records and search snapshots are stable.
- Retrieval tests: deterministic fake corpus returns expected chunks.
- Evidence tests: every claim has citation metadata.
- Prompt hook tests: system prompt includes citation/provenance rules.
- Integration tests: `reviewId/evidenceIds` can feed `plan_next_experiment`.

Network tests should be opt-in. Default CI should use fixtures and fake adapters.

## Risks and Controls

| Risk | Control |
| --- | --- |
| Hallucinated citations | Require citation object for every claim and reject uncited evidence |
| Abstract-only overconfidence | Track `extractionMethod` and lower confidence |
| Paywalled content misuse | Mark `fullTextStatus`, require local user-provided PDF for full text |
| Search irreproducibility | Persist query, filters, raw source ids, ranks, and timestamp |
| Vector store opacity | Start with JSONL/SQLite/BM25, add embeddings only after contracts are stable |
| Literature evidence bypasses safety | Evidence feeds planning only; experiment policy/preflight/approval remain authoritative |
| Multi-source duplicates | Canonical `paperId` and identifier-based dedupe |
| Long quotes in answers | Store short evidence quotes only; answer with paraphrase and citations |

## Recommended Starting Point

Start with Phase 0 and Phase 1:

```text
search_literature
  -> OpenAlex/Crossref/arXiv/PubMed metadata
  -> local PaperRecord/SearchRecord
  -> references.bib
```

Then implement `extract_evidence` before adding vector search. The first useful milestone is not a sophisticated RAG system; it is a traceable evidence table that can justify the next `ExperimentSpec`.
