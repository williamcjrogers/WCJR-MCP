import json, glob, os

for path in glob.glob("/sandbox/.openclaw/openclaw.json*"):
    if path.endswith('.json') or path.endswith('.bak'):
        try:
            with open(path) as f:
                c = json.load(f)
            if 'gateway' not in c:
                c['gateway'] = {}
            if 'controlUi' not in c['gateway']:
                c['gateway']['controlUi'] = {}
            c['gateway']['controlUi']['dangerouslyDisableDeviceAuth'] = True
            c['gateway']['controlUi']['allowInsecureAuth'] = True
            c['gateway']['controlUi']['allowedOrigins'] = [
                "http://127.0.0.1:18789",
                "http://localhost:18789",
                "http://localhost:18800",
                "http://[::1]:18789",
                "http://[::1]:18800",
                "http://192.168.1.187:18789",
                "http://192.168.1.187:18800"
            ]
            c['gateway']['auth'] = {"mode": "none"}
            c['gateway']['trustedProxies'] = ["127.0.0.1", "::1", "0.0.0.0"]
            with open(path, 'w') as f:
                json.dump(c, f, indent=2)
            print(f"Fixed: {path}")
        except Exception as e:
            print(f"Skip {path}: {e}")

print("ALL DONE")
