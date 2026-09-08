import requests
r = requests.post("http://127.0.0.1:8765/scrape", json={"url": "https://thatch.com/jobs/software-engineer-backend-5113759008", "timeoutMs": 30000}, timeout=45)
import json
data = r.json()
# Print keys and lengths
print("Top-level keys:", list(data.keys()))
for k, v in data.items():
    if isinstance(v, str):
        print(f"  {k}: ({len(v)} chars) {v[:100]!r}")
    else:
        print(f"  {k}: {v}")

# Check if the json itself contains the full description
print()
print("Full JSON size:", len(r.text))
print("Truncated? Description length in JSON:", len(r.json().get("description") or ""))
