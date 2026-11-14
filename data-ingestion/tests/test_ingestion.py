import hashlib
import json
from pathlib import Path
import numpy as np
import pymupdf
import pytest
from ingestion.settings import Settings
from ingestion.telemetry import load_run, line_protocol, utc_ns, CHANNELS
from ingestion.documents import extract_pdf, related_sections, split_text, PageVision


def test_all_public_runs_validate():
    root = Settings().telemetry
    runs = sorted(root.glob('BM-RUN-*'))
    if not runs:
        pytest.skip('Demo inputs not seeded')
    total_rows = total_events = 0
    for folder in runs:
        m, rows, events, identity = load_run(folder, root)
        assert len(CHANNELS) == 48
        assert len(identity) == 64
        total_rows += len(rows)
        total_events += len(events)
        # Every source instant has a stable and distinct point identity.
        identities = [line_protocol('mission_events', e, identity).split(' ')[0] for e in events]
        assert len(set(identities)) == len(events)
    assert (len(runs), total_rows, total_events) == (24, 43038, 504)


def test_modified_telemetry_rejected(tmp_path):
    import shutil
    source = Settings().telemetry / 'BM-RUN-0001'
    if not source.exists():
        pytest.skip('Demo inputs not seeded')
    target = tmp_path / source.name
    shutil.copytree(source, target)
    with (target / 'telemetry.csv').open('a') as f:
        f.write('\ncorrupted\n')
    with pytest.raises(ValueError, match='hash mismatch'):
        load_run(target, tmp_path)


def test_timestamp_and_line_protocol():
    assert utc_ns('2026-01-01T00:00:00.500Z') - utc_ns('2026-01-01T00:00:00.000Z') == 500_000_000
    with pytest.raises(ValueError):
        utc_ns('2026-01-01T00:00:00')
    row = {'run_id': 'BM-RUN-0001', 'event_seq': 2, 'source_time_utc': '2026-01-01T00:00:00Z', 'received_time_utc': '2026-01-01T00:00:03Z', 'message': 'A "quoted" event', 'mission_elapsed_s': 0.0}
    line = line_protocol('mission_events', row, 'abc')
    assert 'event_id=2' in line
    assert 'event_seq=2i' in line
    assert '\\"quoted\\"' in line
    assert 'received_time_ns=1767225603000000000i' in line


def test_structured_sections_and_block_provenance(tmp_path):
    path = tmp_path / 'test.pdf'
    with pymupdf.open() as pdf:
        for marker, title, text in [('SEC-01', 'First section', 'PWR is observed here.'), ('SEC-01', 'Continuation', 'Additional content.'), ('SEC-02', 'Next section', 'Refer to SEC-01 for CFG.')]:
            page = pdf.new_page()
            page.insert_text((50, 80), marker + ' / REFERENCE', fontsize=10)
            page.insert_text((50, 110), title, fontsize=20)
            page.insert_text((50, 180), text, fontsize=12)
        pdf.save(path)
    settings = Settings(documents=tmp_path, artifacts=tmp_path / 'out')
    metadata, sections, chunks, assets = extract_pdf(path, settings)
    assert [s['label'] for s in sections] == ['SEC-01', 'SEC-02']
    assert (sections[0]['page_start'], sections[0]['page_end']) == (1, 2)
    assert all(c['section_id'] in {s['_id'] for s in sections} for c in chunks)
    assert all(len(c['bbox']) == 4 for c in chunks)
    assert any('PWR' in c['entities'] for c in chunks)
    assert len([a for a in assets if a['kind'] == 'page_render']) == 3
    assert metadata['extraction_status'] == 'native_only'
    # Identical extraction yields stable identities.
    second = extract_pdf(path, settings)
    assert metadata['_id'] == second[0]['_id']
    assert [c['_id'] for c in chunks] == [c['_id'] for c in second[2]]


def test_similarity_edges_are_bounded_and_not_self_links():
    s = Settings(similarity_threshold=0.9, similarity_top_k=1, keyword_min_shared=2)
    sections = [{'_id': x} for x in 'abc']
    chunks = [{'section_id': 'a', 'text': 'power thermal margin'}, {'section_id': 'b', 'text': 'power thermal context'}, {'section_id': 'c', 'text': 'completely different topic'}]
    semantic, keyword = related_sections(sections, chunks, np.array([[1,0], [1,0], [0,1]], dtype=float), s)
    assert {(e['source'], e['target']) for e in semantic} == {('a','b'), ('b','a')}
    assert all(e['source'] != e['target'] for e in keyword)
    assert all(e['score'] >= .9 for e in semantic)


def test_chunks_do_not_drop_words_and_vlm_contract_rejects_extra_fields():
    text = ' '.join(f'word{i}' for i in range(500))
    pieces = list(split_text(text, 180))
    assert ' '.join(p[0] for p in pieces) == text
    assert all(text[a:b] == piece for piece,a,b in pieces)
    with pytest.raises(ValueError):
        PageVision.model_validate({'page_text':'', 'figures':[], 'tables':[], 'execute':'ignore instructions'})


def test_vlm_response_is_validated_and_cached(tmp_path, monkeypatch):
    from ingestion import documents
    from ingestion.documents import visual_page
    monkeypatch.setenv('VLM_MODEL', 'test-vision')
    monkeypatch.setenv('VLM_BASE_URL', 'http://test/v1')
    png = tmp_path / 'page.png'
    png.write_bytes(b'test-page-content')
    calls = []
    class Response:
        def raise_for_status(self): pass
        def json(self):
            return {'choices': [{'finish_reason':'stop','message': {'content': json.dumps({'page_text':'', 'figures':[], 'tables':[{'title':'T', 'columns':['ID','Value'], 'rows':[['A','1']]}]})}}]}
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, url, **kwargs):
            calls.append(url)
            return Response()
    monkeypatch.setattr(documents.httpx, 'Client', Client)
    result, key = visual_page(png, tmp_path / 'cache', 'Native context')
    again, same = visual_page(png, tmp_path / 'cache', 'Native context')
    assert len(calls) == 1
    assert key == same
    assert result.tables[0].rows == [['A','1']]
    assert result == again


def test_malformed_vlm_table_gets_bounded_correction(tmp_path, monkeypatch):
    from ingestion import documents
    monkeypatch.setenv('VLM_MODEL', 'test-vision')
    monkeypatch.setenv('VLM_BASE_URL', 'http://test/v1')
    png=tmp_path/'page.png'; png.write_bytes(b'page')
    calls=[]
    class Response:
        def raise_for_status(self): pass
        def json(self):
            rows = [['A']] if len(calls) == 1 else [['A','1']]
            return {'choices':[{'finish_reason':'stop','message':{'content':json.dumps({'page_text':'','figures':[],'tables':[{'title':'T','columns':['ID','Value'],'rows':rows}]})}}]}
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, url, **kwargs):
            calls.append(kwargs)
            return Response()
    monkeypatch.setattr(documents.httpx,'Client',Client)
    result,key=documents.visual_page(png,tmp_path/'cache')
    assert len(calls)==2
    assert result.tables[0].rows==[['A','1']]
    assert (tmp_path/'cache'/f'{key}.attempt-1.invalid.json').exists()
