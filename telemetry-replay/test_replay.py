"""Tests for the telemetry replay, on the bundled Brahmastra runs. Standard library only:

    python3 -m unittest -v test_replay.py
"""
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import replay as rp

LIB = rp.Library(rp.DEFAULT_DATA)


class Loading(unittest.TestCase):
    def test_runs_and_summaries(self):
        self.assertEqual(len(LIB.run_ids()), 24)
        self.assertEqual(LIB.get('BM-RUN-0001').summary(), {'id': 'BM-RUN-0001', 'duration_s': 900.0, 'samples': 1800, 'expected_samples': 1800,
                                                            'missing_samples': 0, 'events': 20})
        self.assertEqual(LIB.get('BM-RUN-0010').summary()['missing_samples'], 50)

    def test_channel_kinds(self):
        ch = LIB.get('BM-RUN-0016').channels
        self.assertEqual(ch['pwr_margin_pu'].kind, 'numeric')
        self.assertEqual((ch['pwr_margin_pu'].unit, ch['pwr_margin_pu'].subsystem), ('pu', 'PWR'))
        self.assertEqual(ch['hlt_overall_state'].kind, 'state')
        self.assertEqual(ch['hlt_overall_state'].states, ['DEGRADED', 'NOMINAL', 'WARNING'])
        self.assertEqual(ch['thm_warning'].states, ['false', 'true'])
        for meta in rp.META:
            self.assertNotIn(meta, ch)

    def test_values_match_the_csv(self):
        run = LIB.get('BM-RUN-0001')
        i = run.times.index(100.0)
        self.assertEqual(run.values['pwr_bus_level_pu'][i], 0.856)

    def test_unknown_run(self):
        with self.assertRaises(KeyError):
            LIB.get('BM-RUN-9999')


class Clock(unittest.TestCase):
    def test_paced_by_mission_time(self):
        r = rp.Replay(LIB.get('BM-RUN-0001'), ['pwr_bus_level_pu'], speed=10)
        first = r.advance(1.0)                          # 1 s of wall time at 10x = 10 s of mission time
        self.assertTrue(first['reset'])
        self.assertEqual(first['t'], 10.0)
        self.assertEqual([row[0] for row in first['rows']], [i / 2 for i in range(21)])
        self.assertEqual(len(r.advance(0.5)['rows']), 10)

    def test_pause_speed_and_seek(self):
        r = rp.Replay(LIB.get('BM-RUN-0001'), ['pwr_bus_level_pu', 'hlt_overall_state'], speed=1)
        r.advance(0)
        r.control('pause')
        self.assertEqual(r.advance(5)['rows'], [])
        r.control('speed', 50)
        r.control('seek', 100)
        out = r.advance(0)                              # paused: the seek sends only the history up to 100 s
        self.assertTrue(out['reset'])
        self.assertEqual(out['rows'][-1], [100.0, 0.856, 'NOMINAL'])
        self.assertEqual(out['rows'][0][0], 0.0)        # within the 300 s backlog
        r.control('play')
        self.assertEqual(r.advance(0.1)['t'], 105.0)
        with self.assertRaises(ValueError):
            r.control('speed', 1000)
        with self.assertRaises(ValueError):
            r.control('rewind')

    def test_gap_arrives_as_a_gap(self):
        r = rp.Replay(LIB.get('BM-RUN-0010'), ['daq_missing_samples'], speed=1, start=321.5)
        r.advance(0)
        out = r.advance(25.4)                           # to 346.9 s: inside the source loss
        self.assertEqual(out['rows'], [])
        self.assertEqual([e['type'] for e in out['events']], ['STG_STATE_CONFIRMED', 'SUBPHASE_ENTER'])
        out = r.advance(0.2)
        self.assertEqual(out['rows'], [[347.0, 50.0]])
        self.assertEqual([e['type'] for e in out['events']], ['DAQ_CAPTURE_RESUMED'])

    def test_end_of_run(self):
        r = rp.Replay(LIB.get('BM-RUN-0001'), ['pwr_bus_level_pu'], speed=100, start=899)
        r.advance(0)
        out = r.advance(1)
        self.assertTrue(out['ended'])
        self.assertFalse(out['playing'])
        self.assertEqual(out['rows'][-1][0], 899.5)
        r.control('play')                               # play at the end starts over
        self.assertEqual(r.t, 0.0)


class Server(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), rp.make_handler(LIB, rp.Sessions()))
        cls.httpd.daemon_threads = True
        cls.base = f'http://127.0.0.1:{cls.httpd.server_address[1]}'
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=5) as resp:
            return resp.status, resp.headers.get('Content-Type'), resp.read()

    def status_of(self, path):
        try:
            return self.get(path)[0]
        except urllib.error.HTTPError as e:
            return e.code

    def test_page_runs_and_channels(self):
        status, ctype, body = self.get('/')
        self.assertEqual((status, ctype), (200, 'text/html; charset=utf-8'))
        self.assertIn(b'Telemetry replay', body)
        self.assertEqual(len(json.loads(self.get('/api/runs')[2])), 24)
        channels = json.loads(self.get('/api/runs/BM-RUN-0016/channels')[2])
        self.assertIn({'id': 'hlt_overall_state', 'kind': 'state', 'subsystem': 'HLT', 'states': ['DEGRADED', 'NOMINAL', 'WARNING']}, channels)
        self.assertEqual(json.loads(self.get('/api/health')[2])['runs'], 24)

    def test_stream_and_control(self):
        resp = urllib.request.urlopen(self.base + '/api/stream?run=BM-RUN-0016&pids=pwr_margin_pu,hlt_overall_state&speed=100&start=350', timeout=5)
        self.assertEqual(resp.headers.get('Content-Type'), 'text/event-stream')
        events = []
        while len(events) < 4:
            line = resp.readline().decode()
            if line.startswith('event: '):
                name = line[7:].strip()
                data = json.loads(resp.readline().decode()[6:])
                events.append((name, data))
        hello = events[0]
        self.assertEqual(hello[0], 'hello')
        self.assertEqual([p['id'] for p in hello[1]['pids']], ['pwr_margin_pu', 'hlt_overall_state'])
        ticks = [d for n, d in events[1:]]
        self.assertTrue(ticks[0]['reset'])
        rows = [r for d in ticks for r in d['rows']]
        self.assertIn([352.5, 0.4118, 'WARNING'], rows)                  # the PWR warning sample of BM-RUN-0016
        req = urllib.request.Request(self.base + '/api/control', data=json.dumps({'session': hello[1]['session'], 'action': 'pause'}).encode(),
                                     headers={'Content-Type': 'application/json'}, method='POST')
        self.assertEqual(json.loads(urllib.request.urlopen(req, timeout=5).read()), {'ok': True})
        resp.close()

    def test_rejects_bad_requests(self):
        six = ','.join(['pwr_margin_pu', 'pwr_load_pu', 'pwr_bus_level_pu', 'thm_core_temp_pu', 'thm_delta_pu', 'daq_quality_pu'])
        self.assertEqual(self.status_of(f'/api/stream?run=BM-RUN-0016&pids={six}'), 400)
        self.assertEqual(self.status_of('/api/stream?run=BM-RUN-0016&pids=not_a_channel'), 400)
        self.assertEqual(self.status_of('/api/stream?run=BM-RUN-9999&pids=pwr_margin_pu'), 404)
        self.assertEqual(self.status_of('/api/runs/BM-RUN-9999/channels'), 404)
        self.assertEqual(self.status_of('/nothing'), 404)
        for bad in ('speed=0', 'speed=-5', 'speed=1000', 'speed=nan', 'speed=abc', 'start=-1', 'start=901', 'start=nan'):
            self.assertEqual(self.status_of(f'/api/stream?run=BM-RUN-0016&pids=pwr_margin_pu&{bad}'), 400, bad)
        self.assertEqual(self.status_of('/../../etc/passwd'), 404)
        self.assertEqual(self.status_of('/api/runs/..%2F..%2Fetc/channels'), 404)


if __name__ == '__main__':
    unittest.main()
