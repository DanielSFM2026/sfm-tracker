# -*- coding: utf-8 -*-
"""
Wipe all job/test data for a fresh testing wave — every department
(weld, kitting, paint, assembly) — while leaving employees, assembly_lines,
break_rules, and build_plan untouched.

Deletes child tables before parents so it's safe regardless of each table's
FK cascade settings. Uses the SERVICE ROLE key (bypasses RLS) — the anon key
the app ships no longer has DELETE rights on anything, by design, so an
admin script like this needs the elevated key. Add
SUPABASE_SERVICE_ROLE_KEY=... to .env (no VITE_ prefix, so it never gets
bundled into the browser) — find it in Supabase > Project Settings > API.

Usage: python clear_test_jobs.py
"""
import os, json, urllib.request, urllib.error

HERE = os.path.dirname(__file__)
ENV_PATH = os.path.join(HERE, '..', '.env')

# Children first, parents last.
TABLES = [
    'paint_batch_members',
    'paint_batch_jobs',
    'paint_batches',
    'job_alerts',
    'job_events',
    'jobs',
]


def read_env():
    env = {}
    with open(ENV_PATH, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    if 'SUPABASE_SERVICE_ROLE_KEY' not in env:
        raise SystemExit(
            'SUPABASE_SERVICE_ROLE_KEY not found in .env.\n'
            'Add it (Supabase > Project Settings > API > service_role key) — '
            'the anon key can no longer bulk-delete now that RLS is locked down.'
        )
    return env['VITE_SUPABASE_URL'], env['SUPABASE_SERVICE_ROLE_KEY']


def count(url, key, table):
    endpoint = f'{url}/rest/v1/{table}?select=*'
    req = urllib.request.Request(endpoint, method='HEAD', headers={
        'apikey': key, 'Authorization': f'Bearer {key}', 'Prefer': 'count=exact',
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        cr = resp.headers.get('Content-Range', '')
        return int(cr.split('/')[-1]) if '/' in cr else None


def delete_all(url, key, table):
    # A PK-based always-true filter (uuid columns are never null) so PostgREST
    # accepts the request as an intentional bulk delete, not a mistaken bare call.
    pk = 'batch_id' if table == 'paint_batches' else (
        'id' if table == 'paint_batch_jobs' else (
        'alert_id' if table == 'job_alerts' else (
        'event_id' if table == 'job_events' else (
        'job_id' if table == 'jobs' else 'id'))))
    endpoint = f'{url}/rest/v1/{table}?{pk}=not.is.null'
    req = urllib.request.Request(endpoint, method='DELETE', headers={
        'apikey': key, 'Authorization': f'Bearer {key}', 'Prefer': 'return=minimal',
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.status


def main():
    url, key = read_env()
    print(f'Target: {url}\n')
    print('Before:')
    for t in TABLES:
        try:
            print(f'  {t:22} {count(url, key, t)} rows')
        except urllib.error.HTTPError as e:
            print(f'  {t:22} (count failed: HTTP {e.code} — table may not exist, skipping)')

    print('\nDeleting...')
    for t in TABLES:
        try:
            status = delete_all(url, key, t)
            print(f'  {t:22} -> HTTP {status}')
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', 'replace')[:300]
            print(f'  {t:22} -> HTTP {e.code} {e.reason}: {body}')

    print('\nAfter:')
    for t in TABLES:
        try:
            print(f'  {t:22} {count(url, key, t)} rows')
        except urllib.error.HTTPError:
            print(f'  {t:22} (table may not exist)')


if __name__ == '__main__':
    main()
