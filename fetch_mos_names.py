#!/usr/bin/env python3
"""Fetch top-100 female names from data.mos.ru and enrich our dataset."""
import json, math, ssl, os
from urllib.request import urlopen
from urllib.parse import urlencode, quote

API_KEY = os.environ.get('DATA_MOS_API_KEY', '')
BASE = 'https://apidata.mos.ru/v1'

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

os.environ.pop('https_proxy', None)
os.environ.pop('HTTPS_PROXY', None)
os.environ['NO_PROXY'] = 'apidata.mos.ru'

def get(path, params=None):
    p = {'api_key': API_KEY}
    if params:
        p.update(params)
    query = '&'.join(f'{k}={quote(str(v))}' for k, v in p.items())
    url = f'{BASE}{path}?{query}'
    with urlopen(url, context=ctx, timeout=30) as r:
        return json.loads(r.read())

# Find the female names dataset
print('Searching for female names dataset...')
resp = get('/datasets', {'$top': '500'})
# Response is {"Items": [...], "Count": N}
datasets = resp.get('Items', resp) if isinstance(resp, dict) else resp
female_ds = None
for d in datasets:
    cap = d.get('Caption', d.get('caption', ''))
    if 'женских' in cap.lower() and 'имен' in cap.lower() and 'новорожд' in cap.lower():
        print(f'  Found: id={d["Id"]} — {cap}')
        female_ds = d
        break
    if 'имен' in cap.lower() and 'новорожд' in cap.lower():
        print(f'  Candidate: id={d["Id"]} — {cap}')

if not female_ds:
    print('Dataset not found, trying known ID 7704111479...')
    # Try direct known IDs
    for try_id in [7704111479, 2280, 60562]:
        try:
            rows = get(f'/datasets/{try_id}/rows', {'$top': '3'})
            if rows and 'Cells' in rows[0]:
                print(f'  Works! Dataset ID = {try_id}')
                print(f'  Sample: {rows[0]["Cells"]}')
                female_ds = {'Id': try_id}
                break
        except Exception as e:
            print(f'  ID {try_id}: {e}')

if not female_ds:
    print('ERROR: Could not find dataset')
    exit(1)

ds_id = female_ds['Id']

# Fetch all rows (100 names × 12 months × ~10 years ≈ 12000 rows)
print(f'\nFetching rows from dataset {ds_id}...')
all_rows = []
skip = 0
while True:
    params = {'top': '1000', 'skip': str(skip)}
    batch = get(f'/datasets/{ds_id}/rows', params)
    if not batch:
        break
    all_rows.extend(batch)
    print(f'  Fetched {len(all_rows)} rows...')
    if len(batch) < 1000:
        break
    skip += 1000

print(f'Total rows: {len(all_rows)}')
if all_rows:
    print(f'Sample row: {all_rows[0]}')

# Aggregate NumberOfPersons by Name (all years)
name_totals = {}
for row in all_rows:
    cells = row.get('Cells', {})
    name = cells.get('Name')
    count = cells.get('NumberOfPersons', 0)
    if name and count:
        name_totals[name] = name_totals.get(name, 0) + int(count)

if not name_totals:
    print('\nCould not parse names — dumping first 3 rows for debugging:')
    for row in all_rows[:3]:
        print(row)
    exit(1)

# Sort by total
sorted_names = sorted(name_totals.items(), key=lambda x: -x[1])
print(f'\nTop 20 female names from data.mos.ru:')
for i, (name, total) in enumerate(sorted_names[:20], 1):
    print(f'  {i:2d}. {name}: {total}')

# Save raw data
with open('data/mos_names_raw.json', 'w') as f:
    json.dump(dict(sorted_names), f, ensure_ascii=False, indent=2)
print(f'\nSaved {len(sorted_names)} names to data/mos_names_raw.json')

# Now update female_names.json and names_enriched.json
with open('data/female_names.json') as f:
    pop = json.load(f)

with open('data/names_enriched.json') as f:
    enriched = json.load(f)

existing_names = {n['name'] for n in enriched}

added = []
updated = []
for name, total in sorted_names:
    if total < 50:  # Skip very rare names
        continue
    if name in pop:
        # Update with real data if Moscow data is more informative
        old = pop[name].get('total', 0)
        if total > old * 0.3:  # Moscow = ~30% of Russia
            # Estimate national total as Moscow * 3.3
            national_estimate = round(total * 3.3)
            pop[name]['total'] = max(pop[name].get('total', 0), national_estimate)
            pop[name]['moscow_total'] = total
            updated.append(name)
    else:
        pop[name] = {'total': round(total * 3.3), 'moscow_total': total, 'byYear': {}}
        added.append(name)

print(f'\nUpdated {len(updated)} existing names with Moscow data')
print(f'Added {len(added)} new names: {added}')

# Add new names to enriched
for name in added:
    enriched.append({'name': name, 'popularity': 0})

# Recalculate popularities
all_totals = [pop.get(n['name'], {}).get('total', 0) for n in enriched]
max_total = max(all_totals) if all_totals else 1
log_max = math.log(max_total + 1)

for n in enriched:
    raw = pop.get(n['name'], {}).get('total', 0)
    n['popularity'] = round(math.log(raw + 1) / log_max, 4) if raw > 0 else 0.0

enriched.sort(key=lambda n: n['name'])

with open('data/female_names.json', 'w') as f:
    json.dump(pop, f, ensure_ascii=False, indent=2)

with open('data/names_enriched.json', 'w') as f:
    json.dump(enriched, f, ensure_ascii=False, indent=2)

print(f'\nDone! names_enriched.json: {len(enriched)} entries')
print(repr([n["name"] for n in enriched]))
