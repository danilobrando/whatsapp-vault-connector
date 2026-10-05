#!/usr/bin/env python3
"""Emit THIRD-PARTY-LICENSES.md from the installed dependency tree.

Hand-written license inventories go stale the first time someone bumps a
dependency, and a stale one is worse than none: it tells an adopter something
false about their obligations. This reads node_modules and reports what is
actually there. Run `--check` in CI to fail when a new copyleft dependency
appears that the document does not already disclose.
"""
import json, os, sys, pathlib, collections

ROOT = pathlib.Path(__file__).resolve().parent
NM = ROOT / "node_modules"
COPYLEFT = ("GPL", "AGPL", "LGPL", "MPL", "EPL", "CDDL", "SSPL", "CC-BY-SA")

# The prose below the generated table. It is part of the generated document so a
# regeneration does not silently drop the explanation an adopter relies on.
EXPLANATION = """**Not legal advice.** These are the facts; how they apply to what you are
building is a question for your own counsel.

### `libsignal` (GPL-3.0) — the one that matters

`libsignal` implements the Signal Protocol. It is a **required runtime
dependency**: Baileys pulls it in and uses it across its Signal layer, so this
connector cannot encrypt or decrypt a single message without it. Baileys itself
is published as MIT while depending on it; that tension is inherited here, not
created here.

- **Using this on your own machine**: no obligation. Copyleft attaches to
  *distribution*, not to use.
- **Redistributing this repository**: it contains no GPL code. `npm install`
  fetches libsignal from the registry onto your machine.
- **Shipping a product built on this**: the combined work you distribute
  includes GPL-3.0 code. The FSF's position is that dynamic linking still forms
  a combined work; that reading is debated, but if you intend to ship something
  proprietary on top of this, assume GPL-3.0 terms apply to the combination and
  take advice before you do.

If a clean permissive story matters to you more than this particular
implementation does, [whatsmeow](https://github.com/tulir/whatsmeow) (Go) is
MPL-2.0 — file-level copyleft, far weaker, and explicitly designed to be
combined with differently-licensed larger works.

### `codec-parser` (LGPL-3.0-or-later)

A transitive dependency of some Baileys audio paths (`music-metadata`). This
connector never parses audio — the read-only tray records audio as an omitted
attachment — so where it is present in the tree it is not exercised, and
depending on the resolved Baileys version it may not be present at all. It is
named here because an adopter auditing the combined work should know it can
enter the tree; LGPL is satisfied by dynamic linking in normal use.

### `sharp` and `@img/*` (Apache-2.0 / LGPL for the libvips bindings)

A **peer** dependency of Baileys, used for image processing. The connector does
not import `sharp`, and the Windows read-only artifact **excludes** it and its
native `@img/*` binaries at build time. If it is absent, it is not in your
combined work.

### `transport` (no declared license)

An orphan in the tree: nothing depends on it. Verify with
`npm ls transport` and remove it if your install still carries it."""

def scan():
    seen = {}
    for d, _dirs, files in os.walk(NM):
        if "package.json" not in files or d.count("node_modules") > 3:
            continue
        try:
            p = json.load(open(os.path.join(d, "package.json")))
        except Exception:
            continue
        name, ver = p.get("name"), p.get("version")
        if not name or not ver:
            continue
        lic = p.get("license") or p.get("licenses")
        if isinstance(lic, list):
            lic = ",".join(x.get("type", str(x)) if isinstance(x, dict) else str(x) for x in lic)
        if isinstance(lic, dict):
            lic = lic.get("type", "?")
        seen[(name, ver)] = str(lic or "UNDECLARED")
    return seen

def strong(lic):
    u = lic.upper()
    return any(c in u for c in COPYLEFT) or u in ("UNDECLARED", "UNLICENSED")

def main():
    pkgs = scan()
    if not pkgs:
        print("node_modules not found — run npm install first.", file=sys.stderr)
        return 2
    counts = collections.Counter(pkgs.values())
    notable = sorted((n, v, l) for (n, v), l in pkgs.items() if strong(l))

    if "--check" in sys.argv:
        doc = (ROOT.parent / "THIRD-PARTY-LICENSES.md")
        if not doc.is_file():
            # Deployed copies sit beside a vault, not beside the repo's docs.
            # This is a repo-side consistency check; elsewhere it is a no-op.
            print("No THIRD-PARTY-LICENSES.md beside this script (deployed copy).")
            return 0
        text = doc.read_text(encoding="utf-8")
        undisclosed = [n for n, _v, _l in notable if n not in text]
        if undisclosed:
            print("Copyleft/undeclared dependencies not disclosed:", ", ".join(undisclosed))
            return 1
        print(f"All {len(notable)} notable dependencies are disclosed.")
        return 0

    out = ["# Third-party licenses", "",
           "Generated by `scripts/gen-licenses.py` from the installed dependency",
           "tree. Do not edit by hand — regenerate it.", "",
           "## Summary", "", "| License | Packages |", "|---|---:|"]
    for lic, n in counts.most_common():
        out.append(f"| {lic} | {n} |")
    out += ["", "## Dependencies that carry obligations", "",
            "These are the ones that change what you may do with a combined work.",
            "Everything else in the tree is permissive (MIT, BSD, ISC, Apache-2.0).", ""]
    for n, v, l in notable:
        out.append(f"- **`{n}` {v} — {l}**")
    out += ["", "## What this means for you", "", EXPLANATION]
    return "\n".join(out) + "\n"

if __name__ == "__main__":
    r = main()
    if isinstance(r, str):
        print(r, end="")
    else:
        sys.exit(r)
