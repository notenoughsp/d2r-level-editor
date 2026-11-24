"""Animation curve decoding (tools/anim_export.py) on hand-made curves; no game data needed."""
import pathlib
import struct
import sys
import unittest

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "tools"))
import anim_export as ae  # noqa: E402


class Curves(unittest.TestCase):
    def test_trunc_scale_is_the_upper_half_of_a_float(self):
        self.assertEqual(ae.trunc_scale(0x3F80), 1.0)
        self.assertEqual(ae.trunc_scale(struct.unpack("<I", struct.pack("<f", 30.0))[0] >> 16), 30.0)

    def test_identity_and_constants(self):
        self.assertIsNone(ae.curve({"CurveDataHeader_DaIdentity": {}, "Dimension": 3}, "P"))
        t, v = ae.curve({"CurveDataHeader_D3Constant32f": {}, "Controls": [1.0, 2.0, 3.0]}, "P")
        self.assertEqual(list(t), [0.0])
        self.assertEqual(v.tolist(), [[1.0, 2.0, 3.0]])

    def test_d3k16u_knots_and_controls(self):
        cd = {"CurveDataHeader_D3K16uC16u": {}, "OneOverKnotScaleTrunc": 0x41F0,  # 30.0
              "ControlScales": [0.5, 1.0, 2.0], "ControlOffsets": [0.0, -1.0, 10.0], "KnotsControls": [0, 30, 1, 2, 3, 4, 5, 6]}
        t, v = ae.curve(cd, "P")
        self.assertEqual(t.tolist(), [0.0, 1.0])
        self.assertEqual(v.tolist(), [[0.5, 1.0, 16.0], [2.0, 4.0, 22.0]])

    def test_d3i1_uses_one_control_for_all_axes(self):
        cd = {"CurveDataHeader_D3I1K8uC8u": {}, "OneOverKnotScaleTrunc": 0x3F80, "ControlScales": [1.0, 2.0, 3.0],
              "ControlOffsets": [0.0, 0.0, 0.0], "KnotsControls": [0, 2]}
        _, v = ae.curve(cd, "P")
        self.assertEqual(v.tolist(), [[2.0, 4.0, 6.0]])

    def test_uniform_scale(self):
        cd = {"CurveDataHeader_D9I1K16uC16u": {}, "OneOverKnotScaleTrunc": 0x3F80, "ControlScale": 0.5, "ControlOffset": 1.0,
              "KnotsControls": [0, 2]}
        _, v = ae.curve(cd, "S")
        self.assertEqual(v.tolist(), [[2.0, 2.0, 2.0]])

    def test_quantized_quaternions_are_unit_length(self):
        for name, rng in (("D4nK16uC15u", 0x7FFF), ("D4nK8uC7u", 0x7F)):
            rs = np.random.default_rng(1)
            n = 20
            kc = list(range(n))
            for _ in range(n):
                kc += [int(rs.integers(0, rng + 1)) | (int(rs.integers(0, 2)) * (rng + 1)) for _ in range(3)]
            cd = {f"CurveDataHeader_{name}": {}, "ScaleOffsetTableEntries": 0x2310, "OneOverKnotScale": 10.0, "KnotsControls": kc}
            t, q = ae.curve(cd, "O")
            self.assertEqual(len(t), n)
            norms = np.linalg.norm(q, axis=1)
            self.assertTrue(np.all(norms <= 1.0001), name)
            self.assertTrue(np.all(norms > 0.5), name)

    def test_scale_shear_matrix_to_scale(self):
        m = np.array([[2, 0, 0, 0, 3, 0, 0, 0, 4]], float)
        self.assertEqual(ae.scale_of(m, "S").tolist(), [[2, 3, 4]])


if __name__ == "__main__":
    unittest.main()
