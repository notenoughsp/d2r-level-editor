"""Summarize assets/listing.tsv by folder: python -I summarize_listing.py <prefix> [depth]"""
import collections
import pathlib
import sys

listing = pathlib.Path(__file__).resolve().parent.parent / "assets" / "listing.tsv"
prefix = sys.argv[1].lower().replace("/", "\\")
depth = int(sys.argv[2]) if len(sys.argv) > 2 else 1
count, size = collections.Counter(), collections.Counter()
for line in listing.read_text(encoding="utf-8").splitlines()[1:]:
    name, sz, _ = line.split("\t")
    low = name.lower()
    if not low.startswith(prefix):
        continue
    rest = low[len(prefix):].lstrip("\\").split("\\")
    key = "\\".join(rest[:depth]) if len(rest) > depth else "(files)"
    count[key] += 1
    size[key] += int(sz)
for k in sorted(count):
    print(f"{count[k]:7} {size[k] / 1e6:9.1f} MB  {k}")
