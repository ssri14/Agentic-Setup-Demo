#!/usr/bin/env python3
"""Plain telemetry replay for the Brahmastra runs.

Replays a recorded run at a chosen speed, as if it were arriving live: up to five channels (PIDs), with
play, pause, seek and speed changes while it runs. Standard library only: no packages, databases or Docker.

    python3 replay.py                      # browser UI on http://127.0.0.1:8070
    python3 replay.py --console --run BM-RUN-0016 --pids pwr_margin_pu,thm_core_temp_pu --speed 10

The browser UI receives the samples from this server over Server-Sent Events, paced by the samples' own
mission elapsed time, so gaps in a run (lost samples) arrive as gaps.
"""
from __future__ import annotations

import argparse
import csv
import json
import secrets
import sys
import threading
import time
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
DEFAULT_DATA = HERE.parent / 'data-ingestion' / 'missions' / 'brahmastra' / 'telemetry'
MAX_PIDS = 5
SPEEDS = (0.5, 1, 2, 5, 10, 25, 50, 100)
META = ('run_id', 'sample_index', 'mission_elapsed_s', 'source_time_utc', 'received_time_utc')
TICK_S = 0.05            # how often the replay clock advances and due samples are sent
BACKLOG_S = 300          # history sent after a seek, so the charts show the window before the new position
UNITS = {'pu': 'pu', 'ms': 'ms', 's': 's', 'hz': 'Hz', 'pct': '%'}


# ---------------------------------------------------------------- data

@dataclass
class Channel:
    id: str
    kind: str                      # 'numeric' (plotted as a line) or 'state' (text or true/false, plotted as bands)
    unit: str = ''
    subsystem: str = ''
    minimum: float | None = None
    maximum: float | None = None
    integer: bool = False             # every value is a whole number (counters): shown without decimals
    states: list[str] = field(default_factory=list)

    def public(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if v not in (None, '', []) and v is not False}


@dataclass
class Run:
    id: str
    duration: float
    times: list[float]
    values: dict[str, list]       # channel id -> one value per sample (float, str or None)
    channels: dict[str, Channel]
    events: list[dict]

    def summary(self) -> dict:
        expected = int(round(self.duration * 2))
        return {'id': self.id, 'duration_s': self.duration, 'samples': len(self.times), 'expected_samples': expected,
                'missing_samples': max(0, expected - len(self.times)), 'events': len(self.events)}


def check_speed(value) -> float:
    speed = float(value)
    if not 0 < speed <= max(SPEEDS):                  # also rejects NaN
        raise ValueError(f'speed must be more than 0 and at most {max(SPEEDS):g}')
    return speed


def check_time(value, run: 'Run') -> float:
    t = float(value)
    if not 0 <= t <= run.duration:                   # also rejects NaN and infinity
        raise ValueError(f'time must be between 0 and {run.duration:g} s')
    return t


def _number(text: str):
    try:
        return float(text)
    except ValueError:
        return None


def load_run(folder: Path) -> Run:
    """Read one run folder (telemetry.csv, events.jsonl, run_manifest.json) as written by the generator."""
    with open(folder / 'telemetry.csv', newline='') as fh:
        rows = list(csv.DictReader(fh))
    if not rows:
        raise ValueError(f'{folder.name}: telemetry.csv has no rows')
    manifest = json.loads((folder / 'run_manifest.json').read_text()) if (folder / 'run_manifest.json').is_file() else {}
    times = [float(r['mission_elapsed_s']) for r in rows]
    channels: dict[str, Channel] = {}
    values: dict[str, list] = {}
    for column in rows[0]:
        if column in META:
            continue
        raw = [r[column] for r in rows]
        numbers = [_number(v) for v in raw]
        parts = column.split('_')
        unit = UNITS.get(parts[-1], '') if len(parts) > 1 else ''
        if all(n is not None or v == '' for n, v in zip(numbers, raw)) and any(n is not None for n in numbers):
            present = [n for n in numbers if n is not None]
            channels[column] = Channel(column, 'numeric', unit, parts[0].upper(), min(present), max(present), all(n.is_integer() for n in present))
            values[column] = numbers
        else:
            channels[column] = Channel(column, 'state', '', parts[0].upper() if column != 'delivery_state' else '', states=sorted({v for v in raw if v}))
            values[column] = [v or None for v in raw]
    events = []
    if (folder / 'events.jsonl').is_file():
        for line in (folder / 'events.jsonl').read_text().splitlines():
            if line.strip():
                e = json.loads(line)
                events.append({'t': float(e['mission_elapsed_s']), 'seq': e.get('event_seq'), 'subsystem': e.get('subsystem_id', ''),
                               'type': e.get('type', ''), 'message': e.get('message', '')})
        events.sort(key=lambda e: (e['t'], e['seq'] or 0))
    duration = float(manifest.get('duration_s') or (times[-1] + 0.5))
    return Run(folder.name, duration, times, values, channels, events)


class Library:
    """The runs under a data folder, each loaded once on first use."""

    def __init__(self, root: Path):
        self.root = root
        self._cache: dict[str, Run] = {}
        self._lock = threading.Lock()

    def run_ids(self) -> list[str]:
        if not self.root.is_dir():
            return []
        return sorted(p.name for p in self.root.iterdir() if (p / 'telemetry.csv').is_file())

    def get(self, run_id: str) -> Run:
        if run_id not in self.run_ids():
            raise KeyError(f'unknown run {run_id!r}')
        with self._lock:
            if run_id not in self._cache:
                self._cache[run_id] = load_run(self.root / run_id)
            return self._cache[run_id]


# ---------------------------------------------------------------- replay clock

class Replay:
    """A replay clock over one run: advance it by wall-clock time and it returns the samples and events now due.

    The clock follows mission elapsed time, so a stretch without samples (source loss) produces nothing, as it
    would on a live link. Thread-safe: the stream loop advances it while control requests change it.
    """

    def __init__(self, run: Run, pids: list[str], speed: float = 1.0, start: float = 0.0):
        self.run, self.pids = run, pids
        self.speed = speed
        self.playing = True
        self.t = max(0.0, min(start, run.duration))
        self._lock = threading.Lock()
        self._reset = True                       # the next advance sends the history before t first
        self._changed = False                    # a control request was applied: report it at the next tick
        self._i = self._index_after(self.t)      # next sample to send
        self._e = self._event_after(self.t)      # next event to send

    def _index_after(self, t: float) -> int:
        times, lo, hi = self.run.times, 0, len(self.run.times)
        while lo < hi:
            mid = (lo + hi) // 2
            if times[mid] <= t:
                lo = mid + 1
            else:
                hi = mid
        return lo

    def _event_after(self, t: float) -> int:
        return next((k for k, e in enumerate(self.run.events) if e['t'] > t), len(self.run.events))

    def row(self, i: int) -> list:
        return [self.run.times[i], *(self.run.values[p][i] for p in self.pids)]

    def control(self, action: str, value=None) -> None:
        with self._lock:
            self._changed = True
            if action == 'play':
                if self.t >= self.run.duration:
                    self._seek(0.0)
                self.playing = True
            elif action == 'pause':
                self.playing = False
            elif action == 'speed':
                self.speed = check_speed(value)
            elif action == 'seek':
                self._seek(check_time(value, self.run))
            else:
                raise ValueError(f'unknown action {action!r}')

    def _seek(self, t: float) -> None:
        self.t = max(0.0, min(t, self.run.duration))
        self._i, self._e, self._reset = self._index_after(self.t), self._event_after(self.t), True

    def advance(self, wall_dt: float) -> dict:
        """Move the clock on by wall_dt seconds of real time; return what became due."""
        with self._lock:
            out: dict = {'t': 0.0, 'playing': self.playing, 'speed': self.speed}
            if self._reset:
                lo = self._index_after(self.t - BACKLOG_S) if self.t > BACKLOG_S else 0
                out['reset'] = True
                out['rows'] = [self.row(i) for i in range(lo, self._i)]
                out['events'] = [e for e in self.run.events if e['t'] <= self.t]
                self._reset = False
            else:
                out['rows'], out['events'] = [], []
            if self.playing:
                self.t = min(self.run.duration, self.t + wall_dt * self.speed)
                while self._i < len(self.run.times) and self.run.times[self._i] <= self.t:
                    out['rows'].append(self.row(self._i))
                    self._i += 1
                while self._e < len(self.run.events) and self.run.events[self._e]['t'] <= self.t:
                    out['events'].append(self.run.events[self._e])
                    self._e += 1
                if self.t >= self.run.duration:
                    self.playing = False
                    out['ended'] = True
            out['t'], out['playing'], out['speed'] = round(self.t, 3), self.playing, self.speed
            if self._changed:
                out['changed'], self._changed = True, False
            return out


# ---------------------------------------------------------------- web server

class Sessions:
    def __init__(self):
        self._by_id: dict[str, Replay] = {}
        self._lock = threading.Lock()

    def add(self, replay: Replay) -> str:
        sid = secrets.token_urlsafe(9)
        with self._lock:
            self._by_id[sid] = replay
        return sid

    def get(self, sid: str) -> Replay | None:
        with self._lock:
            return self._by_id.get(sid)

    def remove(self, sid: str) -> None:
        with self._lock:
            self._by_id.pop(sid, None)


def make_handler(library: Library, sessions: Sessions):
    static = HERE / 'static'

    class Handler(BaseHTTPRequestHandler):
        server_version = 'TelemetryReplay/1.0'

        def log_message(self, fmt, *args):            # quiet: one line per stream, not per request
            pass

        def _send(self, status: int, body: bytes, ctype: str) -> None:
            self.send_response(status)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(body)

        def _json(self, data, status: int = 200) -> None:
            self._send(status, json.dumps(data).encode(), 'application/json')

        def _error(self, status: int, message: str) -> None:
            self._json({'error': message}, status)

        def do_GET(self):
            url = urlparse(self.path)
            q = {k: v[-1] for k, v in parse_qs(url.query).items()}
            parts = [p for p in url.path.split('/') if p]
            try:
                if url.path in ('/', '/index.html'):
                    return self._send(200, (static / 'index.html').read_bytes(), 'text/html; charset=utf-8')
                if url.path == '/api/runs':
                    return self._json([library.get(r).summary() for r in library.run_ids()])
                if len(parts) == 4 and parts[:2] == ['api', 'runs'] and parts[3] == 'channels':
                    return self._json([c.public() for c in library.get(parts[2]).channels.values()])
                if url.path == '/api/stream':
                    return self._stream(q)
                if url.path == '/api/health':
                    return self._json({'ok': True, 'runs': len(library.run_ids()), 'data': str(library.root)})
                return self._error(404, 'not found')
            except KeyError as e:
                return self._error(404, str(e.args[0]))
            except ValueError as e:
                return self._error(400, str(e))

        def do_POST(self):
            url = urlparse(self.path)
            if url.path != '/api/control':
                return self._error(404, 'not found')
            try:
                length = int(self.headers.get('Content-Length') or 0)
                body = json.loads(self.rfile.read(min(length, 4096)) or b'{}')
                replay = sessions.get(str(body.get('session', '')))
                if not replay:
                    return self._error(404, 'no such replay session')
                replay.control(str(body.get('action')), body.get('value'))
                return self._json({'ok': True})
            except (ValueError, TypeError) as e:
                return self._error(400, str(e))

        def _stream(self, q: dict) -> None:
            run = library.get(q.get('run', ''))
            pids = [p for p in q.get('pids', '').split(',') if p]
            if not 1 <= len(pids) <= MAX_PIDS:
                raise ValueError(f'choose 1 to {MAX_PIDS} channels')
            unknown = [p for p in pids if p not in run.channels]
            if unknown:
                raise ValueError(f'unknown channel(s) for {run.id}: {", ".join(unknown)}')
            replay = Replay(run, pids, check_speed(q.get('speed', 1)), check_time(q.get('start', 0), run))
            if q.get('paused') == '1':
                replay.playing = False
            sid = sessions.add(replay)
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Accel-Buffering', 'no')
            self.end_headers()

            def event(name: str, data) -> None:
                self.wfile.write(f'event: {name}\ndata: {json.dumps(data, separators=(",", ":"))}\n\n'.encode())
                self.wfile.flush()

            try:
                event('hello', {'session': sid, 'run': run.summary(), 'pids': [run.channels[p].public() for p in pids]})
                last, idle = time.monotonic(), 0.0
                while True:
                    time.sleep(TICK_S)
                    now = time.monotonic()
                    out = replay.advance(now - last)
                    last = now
                    if out['rows'] or out['events'] or out.get('reset') or out.get('ended') or out.get('changed') or out['playing'] or idle >= 1.0:
                        event('tick', out)
                        idle = 0.0
                    else:
                        idle += TICK_S                    # paused: a heartbeat each second keeps the connection open
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass                                      # the browser closed the stream (new run, new channels, tab closed)
            finally:
                sessions.remove(sid)

    return Handler


def serve(library: Library, host: str, port: int) -> None:
    server = ThreadingHTTPServer((host, port), make_handler(library, Sessions()))
    server.daemon_threads = True
    runs = library.run_ids()
    shown = 'localhost' if host in ('127.0.0.1', '0.0.0.0') else host
    print(f'Telemetry replay: {len(runs)} run(s) in {library.root}')
    print(f'Open http://{shown}:{port}   (Ctrl+C to stop)')
    if not runs:
        print('No runs found: point --data at a folder of run folders (each with telemetry.csv).', file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')


# ---------------------------------------------------------------- console mode

def console(library: Library, run_id: str, pids: list[str], speed: float, start: float, show_events: bool) -> None:
    run = library.get(run_id)
    unknown = [p for p in pids if p not in run.channels]
    if unknown or not 1 <= len(pids) <= MAX_PIDS:
        sys.exit(f'Choose 1 to {MAX_PIDS} channels of {run_id}. Unknown: {", ".join(unknown) or "-"}\n'
                 f'Available: {", ".join(run.channels)}')
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(line_buffering=True)   # rows appear as they are due, also when piped
    try:
        replay = Replay(run, pids, check_speed(speed), check_time(start, run))
    except ValueError as e:
        sys.exit(str(e))
    width = max(12, *(len(p) for p in pids))
    header = f'{"T+ (s)":>8}  ' + '  '.join(f'{p:>{width}}' for p in pids)
    print(f'{run_id} at {speed:g}x from {start:g} s. Ctrl+C to stop.\n{header}\n{"-" * len(header)}')
    last, previous_t, in_gap = time.monotonic(), None, False
    try:
        while True:
            time.sleep(TICK_S)
            now = time.monotonic()
            out = replay.advance(now - last)
            last = now
            if out.get('reset'):
                out['rows'], out['events'] = [r for r in out['rows'] if r[0] >= start], [e for e in out['events'] if e['t'] >= start]
            due = sorted([('row', r[0], r) for r in out['rows']] + ([('event', e['t'], e) for e in out['events']] if show_events else []), key=lambda x: (x[1], x[0] == 'row'))
            for kind, t, item in due:
                if previous_t is not None and not in_gap and t - previous_t > 0.75:
                    print(f'{"":8}  … no samples after {previous_t:.1f} s')
                    in_gap = True
                if kind == 'event':
                    print(f'{t:8.1f}  ▶ {item["subsystem"]} {item["type"]}: {item["message"]}')
                    continue
                if in_gap:
                    print(f'{"":8}  … samples resume ({t - previous_t - 0.5:.1f} s without samples)')
                    in_gap = False
                previous_t = t
                cells = [('' if v is None else str(int(v)) if isinstance(v, float) and v.is_integer() else f'{v:.4f}' if isinstance(v, float) else str(v)) for v in item[1:]]
                print(f'{t:8.1f}  ' + '  '.join(f'{c:>{width}}' for c in cells))
            if out.get('ended'):
                print('End of run.')
                return
    except KeyboardInterrupt:
        print('\nStopped.')


# ---------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description='Replay a recorded Brahmastra telemetry run at a chosen speed.')
    ap.add_argument('--data', type=Path, default=DEFAULT_DATA, help=f'folder of run folders (default: {DEFAULT_DATA})')
    ap.add_argument('--host', default='127.0.0.1', help='address to listen on (default 127.0.0.1; 0.0.0.0 inside a container)')
    ap.add_argument('--port', type=int, default=8070)
    ap.add_argument('--console', action='store_true', help='print the replay in this terminal instead of serving the browser UI')
    ap.add_argument('--run', default='BM-RUN-0016', help='console mode: run to replay')
    ap.add_argument('--pids', default='pwr_margin_pu,thm_core_temp_pu,hlt_overall_state', help=f'console mode: up to {MAX_PIDS} channels, comma-separated')
    ap.add_argument('--speed', type=float, default=10, help='console mode: replay speed (default 10x)')
    ap.add_argument('--start', type=float, default=0, help='console mode: start at this mission elapsed time (s)')
    ap.add_argument('--events', action='store_true', help='console mode: also print logged events')
    ap.add_argument('--list', action='store_true', help='list the runs and their channels, then exit')
    args = ap.parse_args(argv)
    library = Library(args.data.resolve())
    if args.list:
        for r in library.run_ids():
            s = library.get(r).summary()
            print(f'{r}: {s["samples"]} samples ({s["missing_samples"]} missing), {s["events"]} events, {s["duration_s"]:g} s')
        if library.run_ids():
            print('Channels:', ', '.join(library.get(library.run_ids()[0]).channels))
        return
    if args.console:
        return console(library, args.run, [p for p in args.pids.split(',') if p], args.speed, args.start, args.events)
    serve(library, args.host, args.port)


if __name__ == '__main__':
    try:
        main()
    except BrokenPipeError:                      # output piped into `head` or similar
        sys.stderr.close()
