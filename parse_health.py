#!/usr/bin/env python3
"""Apple Health export.xml -> health.json (daily aggregates, workouts, GPS routes).

Usage: python3 parse_health.py [apple_health_export/] [health.json]
"""
import json, math, re, sys, os, glob
from collections import defaultdict
from xml.etree import ElementTree as ET

# Types summed over the day; everything else is averaged (with min/max kept).
SUM_TYPES = {
    "StepCount", "DistanceWalkingRunning", "DistanceCycling", "DistanceSwimming",
    "DistanceSkatingSports", "ActiveEnergyBurned", "BasalEnergyBurned",
    "FlightsClimbed", "AppleExerciseTime", "AppleStandTime", "TimeInDaylight",
    "DietaryWater", "DietaryCaffeine", "DietaryEnergyConsumed",
    "NumberOfAlcoholicBeverages", "PhysicalEffort",
}
SLEEP_STAGES = {  # HKCategoryValueSleepAnalysis* suffix -> bucket
    "InBed": "inBed", "AsleepUnspecified": "asleep", "AsleepCore": "core",
    "AsleepDeep": "deep", "AsleepREM": "rem", "Awake": "awake",
}


def short(t, prefix):
    return t[len(prefix):] if t.startswith(prefix) else t


def parse(export_dir):
    days = defaultdict(dict)        # date -> metric -> accumulator
    sleep = defaultdict(lambda: defaultdict(float))  # date -> bucket -> hours
    workouts = []
    units = {}
    meta = {}

    path = os.path.join(export_dir, "export.xml")
    for _, el in ET.iterparse(path, events=("end",)):
        tag = el.tag
        if tag == "Record":
            t = el.get("type", "")
            day = el.get("startDate", "")[:10]
            if not day:
                pass
            elif t == "HKCategoryTypeIdentifierSleepAnalysis":
                bucket = SLEEP_STAGES.get(short(el.get("value", ""), "HKCategoryValueSleepAnalysis"))
                if bucket:
                    hrs = (ts(el.get("endDate")) - ts(el.get("startDate"))) / 3600
                    # a night is credited to the day it ends on
                    sleep[el.get("endDate", "")[:10]][bucket] += hrs
            elif t.startswith("HKQuantityTypeIdentifier"):
                name = short(t, "HKQuantityTypeIdentifier")
                try:
                    v = float(el.get("value"))
                except (TypeError, ValueError):
                    el.clear(); continue
                units.setdefault(name, el.get("unit", ""))
                if name in SUM_TYPES:
                    # iPhone and Watch both log steps/distance for the same walk,
                    # so totals are kept per source and reconciled below.
                    days[day].setdefault(name, defaultdict(float))[el.get("sourceName", "?")] += v
                else:
                    a = days[day].get(name)
                    if a is None:
                        days[day][name] = [v, v, v, 1]  # sum, min, max, n
                    else:
                        a[0] += v
                        if v < a[1]: a[1] = v
                        if v > a[2]: a[2] = v
                        a[3] += 1
        elif tag == "Workout":
            # newer exports drop totalDistance/totalEnergyBurned and use WorkoutStatistics
            stats = {short(s.get("type", ""), "HKQuantityTypeIdentifier"): s
                     for s in el.findall("WorkoutStatistics")}
            dist = next((stats[k] for k in ("DistanceWalkingRunning", "DistanceCycling",
                                            "DistanceSwimming", "DistanceSkatingSports") if k in stats), None)
            energy = stats.get("ActiveEnergyBurned")
            hr = stats.get("HeartRate")
            workouts.append({
                "type": short(el.get("workoutActivityType", ""), "HKWorkoutActivityType"),
                "start": el.get("startDate", "")[:16],
                "min": rnd(el.get("duration")),
                "km": rnd(el.get("totalDistance") or stat(dist, "sum")),
                "kcal": rnd(el.get("totalEnergyBurned") or stat(energy, "sum")),
                "hr": rnd(stat(hr, "average")),
                "utc": ts(el.get("startDate")),
            })
        elif tag == "Me":
            meta["dob"] = el.get("HKCharacteristicTypeIdentifierDateOfBirth")
            meta["sex"] = short(el.get("HKCharacteristicTypeIdentifierBiologicalSex", ""), "HKBiologicalSex")
        elif tag == "ExportDate":
            meta["exported"] = el.get("value")
        else:
            continue
        el.clear()

    out_days = {}
    for day, metrics in days.items():
        row = {}
        for name, a in metrics.items():
            if name in SUM_TYPES:
                # ponytail: trust the single source that logged the most that day; a real
                # de-dup would union overlapping record intervals across sources.
                row[name] = rnd(max(a.values()))
            else:
                s, lo, hi, n = a
                row[name] = [rnd(s / n), rnd(lo), rnd(hi)]
        out_days[day] = row
    routes = link_routes(parse_routes(export_dir), workouts)
    return {
        "meta": meta,
        "routes": sorted(routes, key=lambda r: r["start"]),
        "units": units,
        "sumTypes": sorted(SUM_TYPES),
        "days": dict(sorted(out_days.items())),
        "sleep": {d: {k: rnd(v) for k, v in b.items()} for d, b in sorted(sleep.items())},
        "workouts": sorted(workouts, key=lambda w: w["start"]),
    }


TRKPT = re.compile(r'<trkpt lon="([-\d.]+)" lat="([-\d.]+)".*?<time>([^<]+)</time>', re.S)
MIN_GAP_M = 8      # drop points closer together than this - a map can't show them
MAX_POINTS = 600   # per route, after thinning


def metres(a, b):
    """Equirectangular approximation - plenty for thinning a GPS track."""
    lat = math.radians((a[0] + b[0]) / 2)
    return 6371000 * math.hypot(math.radians(b[0] - a[0]), math.radians(b[1] - a[1]) * math.cos(lat))


def parse_routes(export_dir):
    routes = []
    for path in sorted(glob.glob(os.path.join(export_dir, "workout-routes", "*.gpx"))):
        pts, start, dist, prev, kept = [], None, 0.0, None, None
        for lon, lat, t in TRKPT.findall(open(path, encoding="utf-8", errors="replace").read()):
            p = (float(lat), float(lon))
            if start is None:
                start = t
            if prev is not None:
                dist += metres(prev, p)
            prev = p
            if kept is None or metres(kept, p) >= MIN_GAP_M:
                pts.append([round(p[0], 5), round(p[1], 5)])
                kept = p
        if len(pts) < 2:
            continue
        if metres(kept, prev) >= 1:   # keep the true end point, unless it is already the last kept one
            pts.append([round(prev[0], 5), round(prev[1], 5)])
        if len(pts) > MAX_POINTS:            # keep both ends, thin the middle evenly
            step = len(pts) / MAX_POINTS
            pts = [pts[int(i * step)] for i in range(MAX_POINTS)] + [pts[-1]]
        routes.append({
            "name": os.path.basename(path)[6:-4].replace("_", " "),
            "utc": ts(start.replace("Z", " +0000").replace("T", " ")),
            "km": rnd(dist / 1000),
            "pts": pts,
        })
    return routes


def link_routes(routes, workouts):
    """Attach each route to the workout that started nearest it (within 20 min)."""
    for r in routes:
        best = min(workouts, key=lambda w: abs(w["utc"] - r["utc"]), default=None)
        if best is not None and abs(best["utc"] - r["utc"]) <= 1200:
            r["type"] = best["type"]
            r["start"] = best["start"]
            best["route"] = 1
        else:
            r["type"] = "Unmatched"
            r["start"] = r["name"][:10]
    return routes


def ts(s):
    """'2021-11-30 01:30:00 +0200' -> epoch seconds."""
    from datetime import datetime
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S %z").timestamp()


def stat(el, attr):
    """A missing WorkoutStatistics means the value is unknown, not zero."""
    return None if el is None else el.get(attr)


def rnd(v):
    if v is None or v == "":
        return None
    v = float(v)
    return round(v, 2)


def demo():
    import tempfile, textwrap
    xml = textwrap.dedent("""\
        <HealthData>
        <ExportDate value="2025-01-01"/>
        <Me HKCharacteristicTypeIdentifierDateOfBirth="1994-06-09" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale"/>
        <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-01-01 08:00:00 +0200" endDate="2024-01-01 08:10:00 +0200" value="100" sourceName="Watch"/>
        <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-01-01 09:00:00 +0200" endDate="2024-01-01 09:10:00 +0200" value="50" sourceName="Watch"/>
        <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-01-01 08:00:00 +0200" endDate="2024-01-01 08:10:00 +0200" value="90" sourceName="Phone"/>
        <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2024-01-01 08:00:00 +0200" endDate="2024-01-01 08:00:01 +0200" value="60"/>
        <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2024-01-01 08:01:00 +0200" endDate="2024-01-01 08:01:01 +0200" value="80"/>
        <Record type="HKCategoryTypeIdentifierSleepAnalysis" startDate="2024-01-01 23:00:00 +0200" endDate="2024-01-02 05:00:00 +0200" value="HKCategoryValueSleepAnalysisAsleepCore"/>
        <Workout workoutActivityType="HKWorkoutActivityTypeTennis" duration="60" startDate="2024-01-02 18:00:00 +0100" endDate="2024-01-02 19:00:00 +0100"/>
        <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" startDate="2024-01-01 10:00:00 +0200" endDate="2024-01-01 10:30:00 +0200">
          <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="5" unit="km"/>
          <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="300" unit="kcal"/>
          <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="150" unit="count/min"/>
        </Workout>
        </HealthData>
    """)
    d = tempfile.mkdtemp()
    open(os.path.join(d, "export.xml"), "w").write(xml)
    os.mkdir(os.path.join(d, "workout-routes"))
    pt = ('<trkpt lon="{}" lat="{}"><ele>0</ele><time>{}</time></trkpt>')
    # ~11 m apart in latitude, so the 8 m thinning keeps them all
    trk = "".join(pt.format(14.45, 50.0 + i * 0.0001, "2024-01-01T08:00:%02dZ" % i) for i in range(5))
    open(os.path.join(d, "workout-routes", "route_2024-01-01_10.00am.gpx"), "w").write(
        "<gpx><trk><trkseg>%s</trkseg></trk></gpx>" % trk)
    r = parse(d)
    assert r["days"]["2024-01-01"]["StepCount"] == 150, "sum type dedups sources, keeps the biggest"
    assert r["days"]["2024-01-01"]["HeartRate"] == [70, 60, 80], "avg/min/max type"
    assert r["sleep"]["2024-01-02"]["core"] == 6, "sleep credited to wake day"
    w = r["workouts"][0]
    assert (w["km"], w["kcal"], w["hr"], w["type"]) == (5, 300, 150, "Running"), w
    assert r["workouts"][1] == {"type": "Tennis", "start": "2024-01-02 18:00", "min": 60.0, "km": None,
                                "kcal": None, "hr": None, "utc": ts("2024-01-02 18:00:00 +0100")}, r["workouts"][1]
    assert r["meta"]["sex"] == "Male"
    rt = r["routes"][0]
    assert len(rt["pts"]) == 5 and rt["pts"][0] == [50.0, 14.45], rt["pts"]
    assert rt["km"] == 0.04, rt["km"]  # 4 hops x ~11 m
    assert rt["type"] == "Running" and w.get("route") == 1, "route linked to its workout"
    print("demo ok")


if __name__ == "__main__":
    if "--demo" in sys.argv:
        demo(); sys.exit()
    src = sys.argv[1] if len(sys.argv) > 1 else "apple_health_export"
    dst = sys.argv[2] if len(sys.argv) > 2 else "health.json"
    data = parse(src)
    with open(dst, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"{dst}: {len(data['days'])} days, {len(data['workouts'])} workouts, "
          f"{len(data['routes'])} routes, {os.path.getsize(dst)/1e6:.1f} MB")
