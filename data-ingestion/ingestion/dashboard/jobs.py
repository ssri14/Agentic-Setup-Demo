"""Single-writer ingestion queue. Jobs run one at a time, matching the pipeline's
one-writer assumption, and their state is persisted to the mission registry."""
import queue
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone

from ..missions import REGISTRY_DATABASE


def now():
    return datetime.now(timezone.utc).isoformat()


class JobManager:
    def __init__(self, mongo_client, history=50):
        self.collection = mongo_client[REGISTRY_DATABASE].dashboard_jobs
        self.lock = threading.Lock()
        self.jobs = {}
        self.queue = queue.Queue()
        self.history = history
        # A dashboard restart interrupts any job that was running; say so rather than show it as running.
        self.collection.update_many({'status': {'$in': ['queued', 'running']}},
            {'$set': {'status': 'interrupted', 'finished_at': now(), 'error': 'Dashboard restarted while this job was pending or running'}})
        for job in self.collection.find().sort('created_at', -1).limit(history):
            job['id'] = job.pop('_id')
            self.jobs[job['id']] = job
        threading.Thread(target=self._worker, daemon=True, name='ingestion-worker').start()

    def submit(self, mission, kind, target, runner, **options):
        job = {'id': uuid.uuid4().hex[:12], 'mission': mission, 'kind': kind, 'target': target, 'options': options,
            'status': 'queued', 'stage': 'queued', 'current': None, 'total': None, 'log': [],
            'created_at': now(), 'started_at': None, 'finished_at': None, 'result': None, 'error': None}
        with self.lock:
            self.jobs[job['id']] = job
        self._persist(job)
        self.queue.put((job['id'], runner))
        return job

    def list(self, mission=None):
        with self.lock:
            jobs = [dict(j, log=list(j['log'][-40:])) for j in self.jobs.values() if mission in (None, j['mission'])]
        return sorted(jobs, key=lambda j: j['created_at'], reverse=True)[:self.history]

    def busy(self):
        with self.lock:
            return any(j['status'] in ('queued', 'running') for j in self.jobs.values())

    def _persist(self, job):
        record = {k: v for k, v in job.items() if k != 'id'}
        record['log'] = record['log'][-200:]
        self.collection.replace_one({'_id': job['id']}, record, upsert=True)

    def _worker(self):
        while True:
            job_id, runner = self.queue.get()
            job = self.jobs[job_id]
            last_saved = [0.0]

            def progress(stage, current=None, total=None):
                with self.lock:
                    changed = stage != job['stage']
                    job.update(stage=stage, current=current, total=total)
                    if changed:
                        job['log'].append(f'{time.strftime("%H:%M:%S")} {stage}')
                if changed or time.monotonic() - last_saved[0] > 2:
                    last_saved[0] = time.monotonic()
                    self._persist(job)

            def log(message):
                with self.lock:
                    job['log'].append(f'{time.strftime("%H:%M:%S")} {message}')

            with self.lock:
                job.update(status='running', stage='starting', started_at=now())
            self._persist(job)
            try:
                result = runner(progress, log)
                with self.lock:
                    job.update(status='complete', stage='complete', result=result, finished_at=now())
                    job['log'].append(f'{time.strftime("%H:%M:%S")} complete')
            except Exception as exc:
                with self.lock:
                    job.update(status='failed', stage='failed', error=f'{type(exc).__name__}: {exc}'[:1000], finished_at=now())
                    job['log'].append(f'{time.strftime("%H:%M:%S")} failed: {type(exc).__name__}: {str(exc)[:300]}')
                    job['log'].extend(traceback.format_exc().splitlines()[-6:])
            self._persist(job)
            with self.lock:
                finished = sorted((j for j in self.jobs.values() if j['status'] not in ('queued', 'running')), key=lambda j: j['created_at'])
                for old in finished[:-self.history]:
                    self.jobs.pop(old['id'], None)
