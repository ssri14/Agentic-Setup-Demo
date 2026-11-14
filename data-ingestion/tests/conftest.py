import json
import os
import tempfile
from pathlib import Path

# The dashboard creates its store clients on import; give tests a placeholder token
# when the real secret is not present (for example outside the container).
if not Path(os.getenv('INFLUX_TOKEN_FILE', 'secrets/influx-admin.json')).is_file():
    token = Path(tempfile.mkdtemp()) / 'influx-admin.json'
    token.write_text(json.dumps({'token': 'test-only'}))
    os.environ['INFLUX_TOKEN_FILE'] = str(token)
