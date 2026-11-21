#!/usr/bin/env python3
"""Build curved MTR tracks from OpenStreetMap railway centre lines.

Geofabrik's free Hong Kong shapefile stores each named railway way. This
script joins those ways into one linestring per service path, following the
station order already used by the map. The result is scripts/track-cache.json.
prepare_data.py copies it into the network file.

Download once, then run:

    python3 scripts/build_tracks.py /path/to/hong-kong-latest-free.shp.zip
"""

from __future__ import annotations

import heapq
import json
import math
import sys
import zipfile
from pathlib import Path

import shapefile

ROOT = Path(__file__).resolve().parents[1]
CACHE_PATH = ROOT / "scripts" / "geocode-cache.json"
OUT_PATH = ROOT / "scripts" / "track-cache.json"

# Names on the OSM ways that belong to each service. Shared Lantau tracks are
# included for the Airport Express and Tung Chung Line because some sections
# are tagged only with the corridor name.
LINE_NAMES = {
    "ISL": ["港鐵港島綫 MTR Island Line"],
    "TWL": ["港鐵荃灣綫 MTR Tsuen Wan Line"],
    "KTL": ["港鐵觀塘綫 MTR Kwun Tong Line"],
    "TKL": ["港鐵將軍澳綫 MTR Tseung Kwan O Line"],
    "EAL": [
        "港鐵東鐵綫 MTR East Rail Line",
        "港鐵東鐵綫馬場支綫 MTR East Rail Line (Racecourse Spur)",
        "港鐵東鐵綫（落馬洲支綫） MTR East Rail Line (Lok Ma Chau Spur Line)",
    ],
    "TML": ["港鐵屯馬綫 MTR Tuen Ma Line"],
    "TCL": ["港鐵東涌綫 MTR Tung Chung Line", "大嶼山及機場鐵路 Lantau and Airport Railway"],
    "AEL": ["港鐵機場快綫 MTR Airport Express", "大嶼山及機場鐵路 Lantau and Airport Railway"],
    "SIL": [
        "港鐵南港島綫 MTR South Island Line",
        "港鐵南港島綫 MTR South Island Line (south line)",
        "港鐵南港島綫 MTR South Island Line (north line)",
    ],
    "DRL": ["港鐵迪士尼綫 MTR Disneyland Resort Line"],
}

PATHS = {
    "ISL": [["KET", "HKU", "SYP", "SHW", "CEN", "ADM", "WAC", "CAB", "TIH", "FOH", "NOP", "QUB", "TAK", "SWH", "SKW", "HFC", "CHW"]],
    "TWL": [["CEN", "ADM", "TST", "JOR", "YMT", "MOK", "PRE", "SSP", "CSW", "LCK", "MEF", "LAK", "KWF", "KWH", "TWH", "TSW"]],
    "KTL": [["WHA", "HOM", "YMT", "MOK", "PRE", "SKM", "KOT", "LOF", "WTS", "DIH", "CHH", "KOB", "NTK", "KWT", "LAT", "YAT", "TIK"]],
    "TKL": [["NOP", "QUB", "YAT", "TIK", "TKO", "HAH", "POA"], ["TIK", "TKO", "LHP"]],
    "EAL": [
        ["ADM", "EXC", "HUH", "MKK", "KOT", "TAW", "SHT", "FOT", "UNI", "TAP", "TWO", "FAN", "SHS", "LOW"],
        ["SHS", "LMC"],
        ["FOT", "RAC", "UNI"],
    ],
    "TML": [["WKS", "MOS", "HEO", "TSH", "SHM", "CIO", "STW", "CKT", "TAW", "HIK", "DIH", "KAT", "SUW", "TKW", "HOM", "HUH", "ETS", "AUS", "NAC", "MEF", "TWW", "KSR", "YUL", "LOP", "TIS", "SIH", "TUM"]],
    "TCL": [["HOK", "KOW", "OLY", "NAC", "LAK", "TSY", "SUN", "TUC"]],
    "AEL": [["HOK", "KOW", "TSY", "AIR", "AWE"]],
    "SIL": [["ADM", "OCP", "WCH", "LET", "SOH"]],
    "DRL": [["SUN", "DIS"]],
}


def distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    radius = 6_371_000.0
    lat1, lat2 = math.radians(a[1]), math.radians(b[1])
    dlat = lat2 - lat1
    dlng = math.radians(b[0] - a[0])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * radius * math.asin(min(1.0, math.sqrt(h)))


def length_m(coords: list[tuple[float, float]]) -> float:
    return sum(distance_m(a, b) for a, b in zip(coords, coords[1:]))


def node_key(lng: float, lat: float) -> tuple[int, int]:
    return (round(lng * 1e5), round(lat * 1e5))


def parts_of(item) -> list[list[tuple[float, float]]]:
    points = [(point[0], point[1]) for point in item.shape.points]
    bounds = list(item.shape.parts) + [len(points)]
    return [points[start:end] for start, end in zip(bounds, bounds[1:]) if end - start >= 2]


def close_enough(segment: list[tuple[float, float]], seeds: list[tuple[float, float]], limit: float) -> bool:
    for point in segment[::2]:
        for seed in seeds:
            if distance_m(point, seed) <= limit:
                return True
    return False


def load_segments(shp_path: Path) -> dict[str, list[list[tuple[float, float]]]]:
    reader = shapefile.Reader(str(shp_path))
    records: list[tuple[str, str, list[tuple[float, float]]]] = []
    for item in reader.iterShapeRecords():
        kind = item.record["fclass"]
        if kind not in {"subway", "rail"}:
            continue
        name = item.record["name"] or ""
        for segment in parts_of(item):
            records.append((name, kind, segment))
    grouped: dict[str, list[list[tuple[float, float]]]] = {}
    for line_id, names in LINE_NAMES.items():
        chosen = [record for record in records if record[0] in names]
        classes = {record[1] for record in chosen}
        pool = [record for record in records if record[0] == "" and record[1] in classes]
        # Unnamed tunnel sections continue a named line. Grow only from geometry
        # already on this line so a parallel railway is not pulled in.
        while True:
            seeds = [point for _, _, segment in chosen for point in segment[::3]]
            added = [record for record in pool if close_enough(record[2], seeds, 45)]
            if not added:
                break
            chosen.extend(added)
            added_ids = {id(record) for record in added}
            pool = [record for record in pool if id(record) not in added_ids]
        grouped[line_id] = [segment for _, _, segment in chosen]
    return grouped


def build_graph(segments: list[list[tuple[float, float]]]):
    nodes: dict[tuple[int, int], tuple[float, float]] = {}
    edges: dict[tuple[int, int], list[tuple[tuple[int, int], float, list[tuple[float, float]]]]] = {}

    def add_edge(start: tuple[int, int], end: tuple[int, int]) -> None:
        if start == end:
            return
        coords = [nodes[start], nodes[end]]
        edges.setdefault(start, []).append((end, distance_m(coords[0], coords[1]), coords))

    for segment in segments:
        keys = []
        for lng, lat in segment:
            key = node_key(lng, lat)
            nodes.setdefault(key, (lng, lat))
            keys.append(key)
        for start, end in zip(keys, keys[1:]):
            add_edge(start, end)
            add_edge(end, start)

    # Join dangling way ends that stop a few metres, or one missing block, apart.
    parent = {key: key for key in nodes}

    def find(key: tuple[int, int]) -> tuple[int, int]:
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key

    def unite(left: tuple[int, int], right: tuple[int, int]) -> None:
        parent[find(left)] = find(right)

    for start, outgoing in edges.items():
        for end, _, _ in outgoing:
            unite(start, end)
    # Surveyed ways often miss each other by a few metres at joints.
    cell = 0.00025
    buckets: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for key, coord in nodes.items():
        buckets.setdefault((int(coord[0] / cell), int(coord[1] / cell)), []).append(key)
    for key, coord in nodes.items():
        cx, cy = int(coord[0] / cell), int(coord[1] / cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for other in buckets.get((cx + dx, cy + dy), []):
                    if other <= key:
                        continue
                    if distance_m(coord, nodes[other]) <= 18:
                        add_edge(key, other)
                        add_edge(other, key)
                        unite(key, other)

    def bridge(candidates: list[tuple[int, int]], targets: list[tuple[int, int]], limit: float) -> None:
        while True:
            best = None
            best_gap = limit
            for start in candidates:
                for end in targets:
                    if start == end or find(start) == find(end):
                        continue
                    gap = distance_m(nodes[start], nodes[end])
                    if gap < best_gap:
                        best = (start, end)
                        best_gap = gap
            if best is None:
                break
            add_edge(*best)
            add_edge(best[1], best[0])
            unite(*best)

    ends = [key for key, outgoing in edges.items() if len(outgoing) == 1]
    bridge(ends, list(nodes), 120)
    ends = [key for key, outgoing in edges.items() if len(outgoing) == 1]
    bridge(ends, ends, 350)
    return nodes, edges


def distance_to_segment(point: tuple[float, float], start: tuple[float, float], end: tuple[float, float]) -> float:
    lat = math.radians((start[1] + end[1]) / 2)
    def xy(coord: tuple[float, float]) -> tuple[float, float]:
        return (
            math.radians(coord[0] - start[0]) * math.cos(lat) * 6_371_000,
            math.radians(coord[1] - start[1]) * 6_371_000,
        )
    start_xy, end_xy, point_xy = xy(start), xy(end), xy(point)
    dx, dy = end_xy[0] - start_xy[0], end_xy[1] - start_xy[1]
    length = dx * dx + dy * dy or 1.0
    along = max(0.0, min(1.0, ((point_xy[0] - start_xy[0]) * dx + (point_xy[1] - start_xy[1]) * dy) / length))
    return math.hypot(point_xy[0] - (start_xy[0] + along * dx), point_xy[1] - (start_xy[1] + along * dy))


def nearest(nodes: dict[tuple[int, int], tuple[float, float]], point: tuple[float, float], limit: float):
    best = None
    best_distance = limit
    for key, coord in nodes.items():
        gap = distance_m(coord, point)
        if gap < best_distance:
            best = key
            best_distance = gap
    return best, best_distance


def shortest(
    nodes,
    edges,
    start: tuple[int, int],
    end: tuple[int, int],
    allowed: set[tuple[int, int]] | None = None,
) -> list[tuple[float, float]] | None:
    if allowed is not None and (start not in allowed or end not in allowed):
        return None
    if start == end:
        return [nodes[start]]
    best_cost = {start: 0.0}
    previous: dict[tuple[int, int], tuple[tuple[int, int], list[tuple[float, float]]]] = {}
    queue = [(0.0, start)]
    while queue:
        cost, current = heapq.heappop(queue)
        if cost != best_cost.get(current):
            continue
        if current == end:
            break
        for nxt, weight, coords in edges.get(current, []):
            if allowed is not None and nxt not in allowed:
                continue
            proposed = cost + weight
            if proposed < best_cost.get(nxt, math.inf):
                best_cost[nxt] = proposed
                previous[nxt] = (current, coords)
                heapq.heappush(queue, (proposed, nxt))
    if end not in previous:
        return None
    pieces: list[list[tuple[float, float]]] = []
    cursor = end
    while cursor != start:
        parent, coords = previous[cursor]
        pieces.append(coords)
        cursor = parent
    pieces.reverse()
    merged = [pieces[0][0]]
    for piece in pieces:
        merged.extend(piece[1:])
    return merged


def simplify(coords: list[tuple[float, float]], tolerance_m: float) -> list[tuple[float, float]]:
    if len(coords) < 3:
        return coords

    def perpendicular(point, start, end) -> float:
        if start == end:
            return distance_m(point, start)
        # Equirectangular metres, accurate enough over a few kilometres.
        lat = math.radians((start[1] + end[1]) / 2)
        def xy(p):
            return (math.radians(p[0] - start[0]) * math.cos(lat) * 6_371_000, math.radians(p[1] - start[1]) * 6_371_000)
        start_xy, end_xy, point_xy = xy(start), xy(end), xy(point)
        dx, dy = end_xy[0] - start_xy[0], end_xy[1] - start_xy[1]
        length = math.hypot(dx, dy) or 1
        return abs(dy * point_xy[0] - dx * point_xy[1]) / length

    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    stack = [(0, len(coords) - 1)]
    while stack:
        left, right = stack.pop()
        worst = 0.0
        index = None
        for cursor in range(left + 1, right):
            gap = perpendicular(coords[cursor], coords[left], coords[right])
            if gap > worst:
                worst = gap
                index = cursor
        if index is not None and worst > tolerance_m:
            keep[index] = True
            stack.append((left, index))
            stack.append((index, right))
    return [coord for coord, kept in zip(coords, keep) if kept]


def round_coords(coords: list[tuple[float, float]]) -> list[list[float]]:
    rounded = []
    for lng, lat in coords:
        point = [round(lng, 5), round(lat, 5)]
        if not rounded or rounded[-1] != point:
            rounded.append(point)
    return rounded


def direct_slice(
    segments: list[list[tuple[float, float]]],
    start: tuple[float, float],
    end: tuple[float, float],
) -> list[tuple[float, float]] | None:
    straight = distance_m(start, end)
    best: tuple[float, list[tuple[float, float]]] | None = None
    for segment in segments:
        start_index = min(range(len(segment)), key=lambda index: distance_m(segment[index], start))
        end_index = min(range(len(segment)), key=lambda index: distance_m(segment[index], end))
        if distance_m(segment[start_index], start) > 160 or distance_m(segment[end_index], end) > 160:
            continue
        piece = segment[min(start_index, end_index) : max(start_index, end_index) + 1]
        if start_index > end_index:
            piece = list(reversed(piece))
        curved = length_m(piece)
        if curved > max(5000, straight * 1.9):
            continue
        if best is None or curved < best[0]:
            best = (curved, piece)
    return None if best is None else best[1]


def trace_path(
    nodes,
    edges,
    segments: list[list[tuple[float, float]]],
    stations: dict,
    codes: list[str],
) -> list[list[float]]:
    joined: list[tuple[float, float]] = []
    for left, right in zip(codes, codes[1:]):
        start_point = (stations[left]["lng"], stations[left]["lat"])
        end_point = (stations[right]["lng"], stations[right]["lat"])
        found = direct_slice(segments, start_point, end_point)
        if found is None:
            start_node, start_gap = nearest(nodes, start_point, 250)
            end_node, end_gap = nearest(nodes, end_point, 250)
            if start_node is None or end_node is None:
                raise SystemExit(f"{left}-{right} is {start_gap:.0f}/{end_gap:.0f} m from the track")
            for buffer in (250, 450, 800, 1400, 2200):
                allowed = {
                    key
                    for key, coord in nodes.items()
                    if distance_to_segment(coord, start_point, end_point) <= buffer
                }
                allowed.add(start_node)
                allowed.add(end_node)
                found = shortest(nodes, edges, start_node, end_node, allowed)
                if found is not None:
                    break
            if found is None:
                # Long bridges leave the straight line between stations.
                relaxed = shortest(nodes, edges, start_node, end_node)
                if relaxed is not None and length_m(relaxed) <= max(6000, distance_m(start_point, end_point) * 1.75):
                    found = relaxed
        if found is None:
            raise SystemExit(f"no track between {left} and {right}")
        piece = [start_point, *found, end_point]
        straight = distance_m(start_point, end_point)
        curved = length_m(piece)
        if curved > max(4000, straight * 2.8):
            raise SystemExit(f"{left}-{right} track is {curved:.0f} m against a {straight:.0f} m straight line")
        piece = simplify(piece, 18)
        if joined:
            piece = piece[1:]
        joined.extend(piece)
    return round_coords(joined)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 scripts/build_tracks.py hong-kong-latest-free.shp.zip")
    archive = Path(sys.argv[1])
    extract = Path("/tmp/hk-rail-shp")
    extract.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(extract, members=[name for name in bundle.namelist() if "railways" in name])
    shp = next(extract.glob("gis_osm_railways_free_1.shp"))
    stations = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    segments = load_segments(shp)
    tracks: dict[str, list[list[list[float]]]] = {}
    for line_id, paths in PATHS.items():
        nodes, edges = build_graph(segments[line_id])
        tracks[line_id] = [trace_path(nodes, edges, segments[line_id], stations, path) for path in paths]
        points = sum(len(path) for path in tracks[line_id])
        print(f"{line_id} ways {len(segments[line_id])} points {points}")
    OUT_PATH.write_text(json.dumps(tracks, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
