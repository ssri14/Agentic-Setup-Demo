# Ingestion validation — 14 November 2026

Status: implemented and exercised on Apple Silicon using Linux ARM64 Docker containers. Four database services are running with persistent volumes. Windows and Linux/Intel hosts have not been exercised.

## Stored data

| Check | Result |
|---|---:|
| Complete public telemetry runs | 24 |
| InfluxDB telemetry records | 43,038 |
| InfluxDB event records | 504 |
| Mission Document pages | 29 |
| Sections, including front matter | 11 |
| MongoDB chunks / Qdrant vectors | 151 / 151 |
| MongoDB / Neo4j assets | 161 / 161 |
| Neo4j NEXT / PREVIOUS section links | 10 / 10 |
| Neo4j related semantic / keyword links | 39 / 52 |
| Neo4j explicit section references | 27 |

Input hashes and manifest counts were checked before telemetry ingestion. Stored counts agree with the sources. Re-ingesting telemetry and the published document preserved point/chunk/vector counts. The first two simultaneous source events survive as distinct records. Typed Boolean fields and half-open source-time retrieval were verified.

## Document and retrieval checks

- The major sections follow the actual SEC-01–SEC-10 running headers, with separate front matter. Multi-page sections retain their page ranges.
- Native extraction produced 109 chunks. VLM enrichment expanded this to 151 chunks, including model-derived table/visual content.
- The four VLM telemetry-dictionary tables contain all 48 registered channel names. This verifies identifier coverage, not the correctness of every transcribed cell.
- VLM output includes 11 caption-anchored figures, 11 figure-register references, and one unanchored visual candidate. Figure references are not classified as actual page figures.
- The real query “How do missing source samples differ from delayed communications delivery?” returned the native acquisition/delivery explanation on page 10 as its top hit (cosine score approximately 0.626).
- That hit resolves to SEC-03. Traversal exposes PREVIOUS → SEC-02 and NEXT → SEC-04, plus related-section links.
- The local VLM was exercised from the Docker container itself and returned the 14-row dictionary table from page 15.

## Tests and reproducibility

All **10 tests passed** in the final dependency-constrained Linux container: eight input/layout/provenance/VLM-contract tests and two integration tests against the running stores. Document integration fixtures use deterministic test vectors in isolated temporary collections; the real semantic search check above uses the actual local MiniLM embeddings.

The final image was built successfully. Direct dependencies and database images are versioned; `constraints.txt` records tested transitive dependencies. The embedding model is revision-pinned. Source/profile IDs, completed extraction reports, asset hashes and accepted VLM responses are retained. Native/VLM evidence stays distinguishable.

## Review limits

VLM output remains **unreviewed model output**. An initial low-resolution probe misread diagram labels, and one table response needed a schema-correction retry. Higher-resolution pages, native-text context, shape validation, bounded corrections and native-caption anchoring improve handling; they do not establish semantic accuracy. Native table detection can produce row fragments. Review the source renders and extracted cells before accepting model-derived facts.

Section detection supports this document's SEC headers, top-level outlines, or explicit page fallback units. General arbitrary-document heading-tree inference is not implemented. Similarity linkage is pairwise over sections and is intended for this small corpus. Ingestion assumes one writer at a time. Cross-database publication uses verified completion records rather than distributed transactions.

The Draft 1.0 Mission Document is the final reference version for this demo. It includes annotated run examples, so downstream benchmark design must account for those hints. No evaluator-only files or generator/registry folders were mounted as ingestion inputs.

## Inspectable records

- [Cross-store counts and graph links](artifacts/verification.json)
- [Final container test results](artifacts/container-tests.log)
- [Real semantic search results](artifacts/search-example.json)
- [Section traversal from the search hit](artifacts/section-example.json)
- [Enriched extraction report](artifacts/195b58ef99ca0082b89f78904c6f2435e2855f43668bcf7336048b78e9d44854/extraction.json)
- [Container-to-VLM table probe](artifacts/container-vlm-probe.log)
- [Final image build](artifacts/build.log)

See [README.md](README.md) for setup, ingestion, retrieval, model configuration and stop/restart commands.
