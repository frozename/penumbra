"""Three short synthetic Gufo requests. Reports stream timing; no inferred token counts."""

import json
import time
import urllib.request

rows = []
with urllib.request.urlopen('http://127.0.0.1:8080/v1/models', timeout=2) as response:
    model = json.load(response)['data'][0]['id']
for index in range(3):
    body = dict(model=model, messages=[{'role': 'user', 'content':
                f'Benchmark control {index}: describe in one short sentence why database transactions are useful.'}],
                max_tokens=64, temperature=0, stream=True)
    started = time.time()
    first = None
    tokens = None
    error = None
    try:
        req = urllib.request.Request('http://127.0.0.1:8080/v1/chat/completions',
                                     data=json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as response:
            for line in response:
                if not line.startswith(b'data: ') or line.strip() == b'data: [DONE]':
                    continue
                data = json.loads(line[6:])
                if data.get('usage'):
                    tokens = data['usage'].get('completion_tokens')
                for choice in data.get('choices', []):
                    delta = choice.get('delta', {})
                    if first is None and (delta.get('content') or delta.get('reasoning_content')):
                        first = time.time()
    except Exception as exc:
        error = type(exc).__name__
    ended = time.time()
    rows.append(dict(index=index, startedAt=started, endedAt=ended,
                     ttftMs=(first-started)*1000 if first else None,
                     elapsedMs=(ended-started)*1000, completionTokens=tokens,
                     effectiveTokensPerSecond=tokens/(ended-started) if tokens and ended>started else None,
                     error=error, synthetic=True, contentLogged=False))
print(json.dumps({'model': model, 'rows': rows, 'caveat': 'Three descriptive samples; cache/order effects uncontrolled. Throughput unavailable without server token usage.'}, indent=2))
