-- ── Add department + sub_department to employees ─────────────────────────────
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS department text
    CHECK (department IN ('weld','assembly','paint','kitting'));

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS sub_department text
    CHECK (sub_department IN ('blast','pack','paint','prep'));

-- Mark existing weld employees
UPDATE employees SET department = 'weld' WHERE badge_code LIKE 'WLD-%';

-- ── Assembly lines ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assembly_lines (
  line_id   integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  line_name text    NOT NULL
);
INSERT INTO assembly_lines (line_name) VALUES
  ('Line 1'),('Line 2'),('Line 3'),('Line 4'),
  ('Line 5'),('Line 6'),('Line 7')
ON CONFLICT DO NOTHING;

-- ── Extend job_events ─────────────────────────────────────────────────────────
ALTER TABLE job_events
  ADD COLUMN IF NOT EXISTS line_id     integer REFERENCES assembly_lines(line_id),
  ADD COLUMN IF NOT EXISTS hold_reason text;

-- ── Assembly employees ─────────────────────────────────────────────────────────
INSERT INTO employees (badge_code, full_name, department) VALUES
  ('ASY-352','Ivan Ivanov',           'assembly'),
  ('ASY-364','Krystian Felinczak',    'assembly'),
  ('ASY-432','Aidan Conway',          'assembly'),
  ('ASY-534','Liam Duffy',            'assembly'),
  ('ASY-562','Jason Forward',         'assembly'),
  ('ASY-579','Darius Naujokas',       'assembly'),
  ('ASY-591','Tadas Taujenis',        'assembly'),
  ('ASY-611','Yusmen Beytulov',       'assembly'),
  ('ASY-612','Andriejus Repkinas',    'assembly'),
  ('ASY-619','Sergejus Bielskis',     'assembly'),
  ('ASY-625','Odhran Fullerton',      'assembly'),
  ('ASY-627','Goncalo Andre',         'assembly'),
  ('ASY-628','Ciaran McParland',      'assembly'),
  ('ASY-632','Serhii Palamarchuk',    'assembly'),
  ('ASY-637','Miguel Lima',           'assembly'),
  ('ASY-638','Radoslaw Ustianowski',  'assembly'),
  ('ASY-640','Lukas Kembre',          'assembly')
ON CONFLICT (badge_code) DO UPDATE SET department = EXCLUDED.department;

-- ── Paint employees ────────────────────────────────────────────────────────────
INSERT INTO employees (badge_code, full_name, department, sub_department) VALUES
  ('BST-053','Marek Zamorski',      'paint','blast'),
  ('BST-513','Jose Da Silva',       'paint','blast'),
  ('PCK-607','Saulius Lenkauskas',  'paint','pack'),
  ('PCK-615','Borislav Todorov',    'paint','pack'),
  ('PNT-522','Marius Vasiliauskas', 'paint','paint'),
  ('PNT-618','Damien Biernacki',    'paint','paint'),
  ('PRE-302','Ruairi McClelland',   'paint','prep'),
  ('PRE-604','Trevor James Foster', 'paint','prep'),
  ('PRE-621','Tomasz Golebiewski',  'paint','prep'),
  ('PRE-636','Daniel Gormley',      'paint','prep')
ON CONFLICT (badge_code) DO UPDATE SET
  department     = EXCLUDED.department,
  sub_department = EXCLUDED.sub_department;

-- ── Kitting / Cutting Shop employees ──────────────────────────────────────────
INSERT INTO employees (badge_code, full_name, department) VALUES
  ('KTR-345','Barry Morton', 'kitting'),
  ('KTR-588','Dylan Flood',  'kitting'),
  ('KTR-600','Shea Carr',    'kitting')
ON CONFLICT (badge_code) DO UPDATE SET department = EXCLUDED.department;
