#!/usr/bin/env python3
"""Repair conversation files whose frontmatter lost the WhatsApp jid domain.

Until v2.12.0 the daemon wrote `jid:` only for groups. Every other conversation
got `phone: "+<digits>"`, which discards the domain — and WhatsApp identifies
newer contacts with LIDs (privacy identifiers, ~14-16 digits) whose jid ends in
`@lid`. The file index then rebuilt those as `<digits>@s.whatsapp.net`, an
address that does not exist, and sends to it were logged as
"Outbound message sent + persisted" with no error while going nowhere.

This does not guess from digit patterns. It reads the jids WhatsApp itself gave
us in `baileys_store.json` and writes the authoritative value into the files
that are missing it. Files with no known contact are left untouched.

    python3 migrate-jids.py                # dry run, prints what would change
    python3 migrate-jids.py --apply        # writes
"""
import json, os, re, sys, pathlib, tempfile

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
STORE = SCRIPT_DIR / "baileys_store.json"
VAULT_ROOT = pathlib.Path(os.environ.get("VAULT_ROOT", SCRIPT_DIR.parent.parent))
INBOX = pathlib.Path(os.environ.get("WA_INBOX_PATH",
                                   VAULT_ROOT / "⚙️ Meta" / "whatsapp-inbox"))

JID_RE = re.compile(r'^jid:\s*"?([^\s"]+)"?', re.M)
PHONE_RE = re.compile(r'^phone:\s*"?\+?(\d+)"?', re.M)
CONTACT_RE = re.compile(r'^(contact:.*)$', re.M)


def ground_truth() -> dict:
    """digits -> the jid WhatsApp actually uses for them."""
    try:
        contacts = json.loads(STORE.read_text(encoding="utf-8")).get("contacts", {})
    except (OSError, ValueError) as e:
        print(f"Cannot read {STORE}: {e}", file=sys.stderr)
        return {}
    out = {}
    for jid in contacts:
        out.setdefault(jid.split("@")[0].split(":")[0], jid)
    return out


def main() -> int:
    apply = "--apply" in sys.argv
    truth = ground_truth()
    if not truth:
        return 2
    if not INBOX.is_dir():
        print(f"No inbox at {INBOX}", file=sys.stderr)
        return 2

    fixed = skipped = unknown = already = 0
    changes = []
    for f in sorted(INBOX.glob("*.md")):
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        head = text[:600]
        if JID_RE.search(head):
            already += 1
            continue
        m = PHONE_RE.search(head)
        if not m:
            skipped += 1
            continue
        real = truth.get(m.group(1))
        if not real:
            unknown += 1
            continue
        inferred = m.group(1) + "@s.whatsapp.net"
        changes.append((f.name, inferred, real))
        if apply:
            # Insert the authoritative jid immediately after `contact:`, keeping
            # `phone:` untouched so nothing that reads it breaks.
            new = CONTACT_RE.sub(lambda mm: f'{mm.group(1)}\njid: "{real}"', text, count=1)
            if new == text:
                skipped += 1
                continue
            tmp = f.with_suffix(f".md.tmp-{os.getpid()}")
            tmp.write_text(new, encoding="utf-8")
            os.replace(tmp, f)
        fixed += 1

    wrong = [c for c in changes if c[1] != c[2]]
    print(f"{'APPLIED' if apply else 'DRY RUN — nothing written'}")
    print(f"  already had jid:      {already}")
    print(f"  repaired:             {fixed}")
    print(f"    of those, the old inference was WRONG: {len(wrong)}")
    print(f"  no known contact:     {unknown}")
    print(f"  no phone/jid at all:  {skipped}")
    if not apply and wrong:
        print("\n  examples of addresses that were silently wrong:")
        for name, inferred, real in wrong[:5]:
            print(f"    {name[:44]:44} {inferred}  ->  {real}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
