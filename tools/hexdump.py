"""hexdump.py <file> [offset] [length]  - hex + ascii, plus the printable strings of the file."""
import re
import sys

d = open(sys.argv[1], "rb").read()
off = int(sys.argv[2], 0) if len(sys.argv) > 2 else 0
n = int(sys.argv[3], 0) if len(sys.argv) > 3 else 256
print("size", len(d))
for o in range(off, min(off + n, len(d)), 16):
    chunk = d[o:o + 16]
    print(f"{o:06x}  {chunk.hex(' '):48}  {''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)}")
if len(sys.argv) <= 2:
    strs = sorted(set(m.decode() for m in re.findall(rb"[ -~]{6,}", d)))
    print("strings:", strs[:60])
