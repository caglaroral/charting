"""Line alert geometry (backend/alerts.py). Run from the repo root: python3 -m unittest tests/backend/test_alert_geometry.py"""
import math
import time
import unittest

from backend.alerts import BarIndex, _evaluate, drawing_levels

H = 3600
# 10 bars, a 100-bar hole in the data, 10 more bars
TIMES = [i * H for i in range(10)] + [(110 + i) * H for i in range(10)]


def trend(p0, p1, **style):
    return {"tool": "trend", "points": [p0, p1], "style": style}


class BarIndexTest(unittest.TestCase):
    def test_gap_takes_no_room(self):
        idx = BarIndex(TIMES, H)
        self.assertEqual(idx(0), 0)
        self.assertEqual(idx(9 * H), 9)
        self.assertEqual(idx(110 * H), 10)  # first bar after the gap is the next index
        self.assertEqual(idx(125 * H), 25)  # after the last bar: one bar per step
        self.assertEqual(idx(-5 * H), -5)   # before the first bar: one bar per step


class LevelsTest(unittest.TestCase):
    def test_line_across_a_gap_follows_bar_index(self):
        d = trend({"t": 0, "p": 100}, {"t": 110 * H, "p": 200})
        idx = BarIndex(TIMES, H)
        # on screen the second point is only 10 bars away: at bar 9 the line is at 190
        self.assertAlmostEqual(drawing_levels(d, 9 * H, idx=idx)[0], 190)
        # interpolated in time it would be 108.2
        self.assertAlmostEqual(drawing_levels(d, 9 * H)[0], 100 + 100 * 9 / 110)

    def test_log_scale(self):
        d = trend({"t": 0, "p": 100}, {"t": 2 * H, "p": 200})
        self.assertAlmostEqual(drawing_levels(d, H, log=True)[0], 100 * math.sqrt(2))
        self.assertAlmostEqual(drawing_levels(d, H)[0], 150)

    def test_extend(self):
        d = trend({"t": 2 * H, "p": 120}, {"t": 0, "p": 100})  # drawn right to left
        self.assertIsNone(drawing_levels(d, 3 * H))
        self.assertAlmostEqual(drawing_levels(dict(d, style={"extend": True}), 3 * H)[0], 130)
        self.assertIsNone(drawing_levels(dict(d, style={"extend": True}), -H))
        self.assertAlmostEqual(drawing_levels(dict(d, style={"extendLeft": True}), -H)[0], 90)

    def test_channel_log(self):
        d = {"tool": "channel", "style": {}, "points": [{"t": 0, "p": 100}, {"t": 2 * H, "p": 400}, {"t": 0, "p": 50}]}
        lo, hi = drawing_levels(d, H, log=True)
        self.assertAlmostEqual(hi, 200)
        self.assertAlmostEqual(lo, 100)


class ClosedTest(unittest.TestCase):
    def run_alert(self, cond, closes, last_forming=True):
        sec = 3600
        now = int(time.time()) // sec * sec
        n = len(closes)
        # the last bar starts at `now` (still forming) or one hour earlier (closed)
        t0 = now - (n - 1) * sec - (0 if last_forming else sec)
        bars = [{"time": t0 + i * sec, "open": c, "high": c, "low": c, "close": c} for i, c in enumerate(closes)]
        alert = {"kind": "price", "cond": cond, "tf": "1h", "spec": {"price": 100}, "last_bar": bars[0]["time"],
                 "last_fired": 0, "frequency": "once_per_bar"}
        fired, _ = _evaluate(alert, bars, {})
        return [round((t - t0) / sec) for t, _ in fired]

    def test_closed_above_skips_the_forming_bar(self):
        self.assertEqual(self.run_alert("closed_above", [90, 95, 105, 110]), [2])   # bar 3 still forming
        self.assertEqual(self.run_alert("closed_above", [90, 95, 105, 110], last_forming=False), [2, 3])
        self.assertEqual(self.run_alert("greater", [90, 95, 105, 110]), [2, 3])     # greater: forming bar too

    def test_closed_below(self):
        self.assertEqual(self.run_alert("closed_below", [120, 99, 98, 50]), [1, 2])


if __name__ == "__main__":
    unittest.main()
