# -*- coding: utf-8 -*-
"""
One-click sync: reads the REAL build plan (SharePoint-synced local copy) and
upserts the SCHEDULE tab into Supabase's build_plan table.

Read-only against the source file — never opens it for writing, never saves
anything back to it. To dodge the "file is open in Excel" lock, this always
copies the workbook to a temp file first and reads the copy.

Double-click via sync_build_plan.bat, or run directly:
  python sync_build_plan.py ["path\\to\\SFM BUILD PLAN 2026a.xlsx"]
"""
import sys, os, json, shutil, tempfile, datetime, urllib.request, urllib.error
import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(HERE, '..', '.env')

# The real, live file — synced locally from SharePoint (SFM-CapacityScheduling).
DEFAULT_XLSX = r'C:\Users\daniel\SFM Engineering\SFM - Capacity Scheduling - Documents\SFM BUILD PLAN 2026a.xlsx'

SHEET, FIRST_DATA_ROW = 'SCHEDULE', 8
BATCH = 300

COLS = {
    'seq_no': 1, 'po_number': 32, 'part_number': 33, 'wo_number': 31, 'sage_wo': 44,
    'model': 68, 'description': 38, 'customer': 41, 'finish': 39, 'quantity': 40,
    'nest_code': 5, 'fab_cat': 8, 'sub_line': 12, 'code': 30,
    'kit_week': 6, 'fab_week': 7, 'paint_week': 9, 'paint_out_week': 10, 'subs_week': 11,
    'cut_week': 13, 'fold_week': 15, 'kitting_week': 17, 'kitting_so': 18,
    'weld_week': 20, 'painting_week': 22, 'subassembly_week': 24,
    'po_received': 42, 'original_date': 45, 'customer_req_date': 46,
    'realign_date': 48, 'delivered': 54, 'del_date': 55,
}
INT_COLS = {'seq_no', 'quantity'}


def read_env():
    env = {}
    with open(ENV_PATH, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env['VITE_SUPABASE_URL'], env['VITE_SUPABASE_ANON_KEY']


def cell(col, v):
    if v is None or v == '':
        return None
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.strftime('%d/%m/%y')
    if col in INT_COLS:
        try:
            return int(v)
        except (TypeError, ValueError):
            return None
    return str(v).strip()


def build_rows(xlsx_path):
    # read_only=True streams the sheet instead of loading the whole workbook
    # (styles, pivot caches, every other tab) into memory — the real file has
    # pivot slicers that make the default mode take tens of minutes.
    wb = openpyxl.load_workbook(xlsx_path, data_only=True, read_only=True)
    ws = wb[SHEET]
    rows, seen = [], set()
    for row in ws.iter_rows(min_row=FIRST_DATA_ROW, values_only=True):
        def get(i):
            return row[i - 1] if i - 1 < len(row) else None
        if get(32) is None and get(33) is None and get(38) is None:
            continue
        rec = {c: cell(c, get(i)) for c, i in COLS.items()}
        if rec['seq_no'] is not None:
            if rec['seq_no'] in seen:
                continue
            seen.add(rec['seq_no'])
        rows.append(rec)
    wb.close()
    return rows


def post_batch(url, key, batch):
    endpoint = f'{url}/rest/v1/build_plan?on_conflict=seq_no'
    body = json.dumps(batch).encode('utf-8')
    req = urllib.request.Request(endpoint, data=body, method='POST', headers={
        'apikey': key,
        'Authorization': f'Bearer {key}',
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.status


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_XLSX
    print(f'Source: {src}')

    if not os.path.exists(src):
        print('ERROR: file not found at that path.')
        print('Check the build plan is synced locally and the path above is still correct.')
        sys.exit(1)

    # Copy first — this works even while the file is open in Excel (copying
    # only needs read access; Excel's lock only blocks opening it directly).
    tmp_dir = tempfile.mkdtemp(prefix='sfm_build_plan_')
    tmp_path = os.path.join(tmp_dir, 'schedule_copy.xlsx')
    try:
        shutil.copy2(src, tmp_path)
    except PermissionError:
        print('ERROR: could not even copy the file — check the path and that OneDrive has it synced.')
        sys.exit(1)

    try:
        url, key = read_env()
        rows = build_rows(tmp_path)
        print(f'Parsed {len(rows)} rows from the SCHEDULE tab.')
        print(f'Posting to {url}/rest/v1/build_plan in batches of {BATCH}...')
        total = 0
        for i in range(0, len(rows), BATCH):
            batch = rows[i:i + BATCH]
            try:
                status = post_batch(url, key, batch)
                total += len(batch)
                print(f'  batch {i // BATCH + 1}: {len(batch)} rows -> HTTP {status}  (total {total})')
            except urllib.error.HTTPError as e:
                print(f'  batch {i // BATCH + 1} FAILED: HTTP {e.code} {e.reason}')
                print('  response:', e.read().decode('utf-8', 'replace')[:800])
                sys.exit(1)
        print(f'\nDone. {total} rows synced to the app.')
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == '__main__':
    main()
