// Brahmastra knowledge graph — demo queries for Neo4j Browser.
// Run the parameter line first. It selects the VLM-enriched Mission Document revision.
// Every node carries a mission property; entity IDs are mission-scoped (brahmastra:DAQ), so match on name.
:param doc => '195b58ef99ca0082b89f78904c6f2435e2855f43668bcf7336048b78e9d44854';

// 1. The document and its ten major sections
MATCH p=(d:Document {id:$doc})-[:HAS_SECTION]->(s:Section)
RETURN p;

// 2. Reading order: SEC-01 → SEC-10
MATCH p=(:Section {document_id:$doc})-[:NEXT]->(:Section)
RETURN p;

// 3. Explicit cross-references ("see SEC-04"), summarised section to section
MATCH (a:Section {document_id:$doc})-[:HAS_CHUNK]->(:Chunk)-[:REFERS_TO]->(b:Section)
RETURN a.label AS from_section, b.label AS to_section, count(*) AS references
ORDER BY from_section, to_section;

// 4. The same references as a graph
MATCH p=(a:Section {document_id:$doc})-[:HAS_CHUNK]->(:Chunk)-[:REFERS_TO]->(:Section)
RETURN p;

// 5. Related-section links: semantic (embedding) and keyword candidates
MATCH p=(:Section {document_id:$doc})-[r:RELATED_SEMANTIC|RELATED_KEYWORD]->(:Section)
RETURN p;

// 6. Where is a subsystem discussed? Change 'DAQ' to any of the 14 subsystem IDs.
MATCH p=(s:Section {document_id:$doc})-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(e:Entity {mission:'brahmastra', name:'DAQ'})
RETURN p;

// 7. Channels of one subsystem and the sections that explain them
MATCH (s:Section {document_id:$doc})-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(e:Entity)
WHERE e.name STARTS WITH 'pwr_' OR e.name STARTS WITH 'hlt_'
RETURN s, e;

// 8. Rules (R01–R12) and the sections that state or use them
MATCH (s:Section {document_id:$doc})-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(e:Entity)
WHERE e.name =~ 'R[0-9]{2}'
RETURN s.label AS section, s.title AS title, collect(DISTINCT e.name) AS rules
ORDER BY section;

// 9. Figures: which sections mention FIG-xx
MATCH (s:Section {document_id:$doc})-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS]->(e:Entity)
WHERE e.name STARTS WITH 'FIG-'
RETURN s, e;

// 10. Agent-style navigation: land on a passage by full-text search,
//     then show its section, neighbours and related sections.
CALL db.index.fulltext.queryNodes('chunk_text', 'dropout OR "missing samples"') YIELD node, score
WHERE node.document_id = $doc
WITH node, score ORDER BY score DESC LIMIT 1
MATCH (s:Section)-[:HAS_CHUNK]->(node)
OPTIONAL MATCH p=(s)-[:NEXT|PREVIOUS|RELATED_SEMANTIC|RELATED_KEYWORD]->(:Section)
RETURN node, s, p;
