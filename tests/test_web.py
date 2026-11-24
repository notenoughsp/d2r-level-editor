"""The browser side: the joined editor script and the translations must be valid JavaScript (needs Node.js)."""
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
NODE = shutil.which("node")


def joined():
    return "\n".join(p.read_text(encoding="utf-8") for p in sorted((WEB / "src").glob("*.js")))


@unittest.skipUnless(NODE, "Node.js not found")
class Web(unittest.TestCase):
    def check(self, text):
        with tempfile.TemporaryDirectory() as d:
            f = pathlib.Path(d) / "script.mjs"
            f.write_text(text, encoding="utf-8")
            r = subprocess.run([NODE, "--check", str(f)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_editor_script_is_valid(self):
        self.check(joined())

    def test_translations_are_valid(self):
        self.check((WEB / "i18n.js").read_text(encoding="utf-8"))

    def test_page_loads_the_editor_script(self):
        self.assertIn('src="/web/editor.js?v=', (WEB / "index.html").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
