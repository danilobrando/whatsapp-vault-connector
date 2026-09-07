#!/usr/bin/env python3
"""Emit the README's check table from wa-fix.py itself.

The table drifted from the code twice: the README described eleven failure modes
while the tool ran seventeen checks, and listed remediations for a layout two
versions old. Generating it means the docs cannot silently lie about what the
tool does. Run `python3 scripts/gen-docs.py --check` in CI to fail on drift.
"""
import re, sys, pathlib

SRC = pathlib.Path(__file__).resolve().parent / "wa-fix.py"
text = SRC.read_text(encoding="utf-8")

names, seen = [], set()
for m in re.finditer(r'CheckResult\(\s*(?:PASS|WARN|FAIL|UNKNOWN)\s*,\s*"([a-z0-9-]+)"', text):
    if m.group(1) not in seen:
        seen.add(m.group(1)); names.append(m.group(1))

needs_human = set(re.findall(r'"([a-z0-9-]+)"', re.search(r'_NEEDS_HUMAN = \{([^}]*)\}', text).group(1)))
# A check is auto-fixable if a `fix_auto=` appears inside the same
# CheckResult(...) call. Scan forward from each occurrence of the name to the
# start of the next CheckResult, rather than trying to match balanced parens.
autofixable = set()
for m in re.finditer(r'CheckResult\(\s*(?:PASS|WARN|FAIL|UNKNOWN)\s*,\s*"([a-z0-9-]+)"', text):
    nxt = text.find("CheckResult(", m.end())
    block = text[m.end(): nxt if nxt != -1 else len(text)]
    if "fix_auto=" in block:
        autofixable.add(m.group(1))

rows = []
for n in names:
    if n in needs_human:
        esc = "`repair` — needs your phone"
    elif n in autofixable:
        esc = "`fix` — automatic"
    else:
        esc = "reported, manual"
    rows.append(f"| `{n}` | {esc} |")

table = ("| Check | If it fails |\n|---|---|\n" + "\n".join(rows)
         + f"\n\n{len(names)} checks. `inbound-freshness` runs first and is the only one "
           "that can veto a healthy verdict.")

if "--check" in sys.argv:
    readme_path = SRC.parent.parent / "README.md"
    if not readme_path.is_file():
        # Deployed copies live next to a vault, not next to the repo's README.
        # This is a repo-side consistency check; outside the repo it is a no-op,
        # not a failure.
        print("No README.md beside this script — nothing to check (deployed copy).")
        sys.exit(0)
    readme = readme_path.read_text(encoding="utf-8")
    missing = [n for n in names if f"`{n}`" not in readme]
    if missing:
        print("README is missing checks:", ", ".join(missing)); sys.exit(1)
    print(f"README documents all {len(names)} checks."); sys.exit(0)

print(table)
