import json
with open('/tmp/openclaw-config.json/openclaw.json') as f:
    config = json.load(f)
config['gateway']['controlUi']['allowedOrigins'] = [
    'http://127.0.0.1:18789',
    'http://localhost:18789',
    'http://localhost:18800',
    'http://192.168.1.187:18789',
    'http://192.168.1.187:18800'
]
with open('/tmp/openclaw-fixed.json', 'w') as f:
    json.dump(config, f, indent=2)
print('CONFIG UPDATED')
