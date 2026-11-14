import os

import uvicorn

if __name__ == '__main__':
    uvicorn.run('ingestion.dashboard.app:app', host=os.getenv('DASHBOARD_HOST', '0.0.0.0'),
        port=int(os.getenv('DASHBOARD_PORT', '8090')), log_level='info')
