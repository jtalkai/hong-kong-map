#!/usr/bin/env python3
"""Rebuild the map data files from official sources and the geocode cache.

Camera locations are downloaded again from DATA.GOV.HK.
Station coordinates are read from scripts/geocode-cache.json. Those coordinates
were looked up once on the Lands Department location search and converted from
the Hong Kong 1980 grid to WGS84. The cache avoids calling that service on
every build.

The camera XML also contains a url field. Two records, AID09104 and AID09206,
point at each other's files. The JPEG named after the key is the one whose
picture is burned with that key and direction, so the app builds the photo
address from the key.
"""

from __future__ import annotations

import json
import math
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE_PATH = ROOT / "scripts" / "geocode-cache.json"
TRACK_PATH = ROOT / "scripts" / "track-cache.json"
NETWORK_PATH = ROOT / "src" / "data" / "network.json"
CAMERAS_PATH = ROOT / "src" / "data" / "cameras.json"
CAMERA_XML = "https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_Tc.xml"

LINES = [
    {
        "id": "ISL",
        "name_tc": "港島綫",
        "name_en": "Island Line",
        "color": "#0075c2",
        "offset": -2,
        "paths": [["KET", "HKU", "SYP", "SHW", "CEN", "ADM", "WAC", "CAB", "TIH", "FOH", "NOP", "QUB", "TAK", "SWH", "SKW", "HFC", "CHW"]],
    },
    {
        "id": "TWL",
        "name_tc": "荃灣綫",
        "name_en": "Tsuen Wan Line",
        "color": "#e2231a",
        "offset": 2,
        "paths": [["CEN", "ADM", "TST", "JOR", "YMT", "MOK", "PRE", "SSP", "CSW", "LCK", "MEF", "LAK", "KWF", "KWH", "TWH", "TSW"]],
    },
    {
        "id": "KTL",
        "name_tc": "觀塘綫",
        "name_en": "Kwun Tong Line",
        "color": "#1a9431",
        "offset": 4,
        "paths": [["WHA", "HOM", "YMT", "MOK", "PRE", "SKM", "KOT", "LOF", "WTS", "DIH", "CHH", "KOB", "NTK", "KWT", "LAT", "YAT", "TIK"]],
    },
    {
        "id": "TKL",
        "name_tc": "將軍澳綫",
        "name_en": "Tseung Kwan O Line",
        "color": "#6b208b",
        "offset": -4,
        "paths": [
            ["NOP", "QUB", "YAT", "TIK", "TKO", "HAH", "POA"],
            ["TIK", "TKO", "LHP"],
        ],
    },
    {
        "id": "EAL",
        "name_tc": "東鐵綫",
        "name_en": "East Rail Line",
        "color": "#53b7e8",
        "offset": 0,
        "paths": [
            ["ADM", "EXC", "HUH", "MKK", "KOT", "TAW", "SHT", "FOT", "UNI", "TAP", "TWO", "FAN", "SHS", "LOW"],
            ["SHS", "LMC"],
            ["FOT", "RAC", "UNI"],
        ],
    },
    {
        "id": "TML",
        "name_tc": "屯馬綫",
        "name_en": "Tuen Ma Line",
        "color": "#9a3b26",
        "offset": 6,
        "paths": [["WKS", "MOS", "HEO", "TSH", "SHM", "CIO", "STW", "CKT", "TAW", "HIK", "DIH", "KAT", "SUW", "TKW", "HOM", "HUH", "ETS", "AUS", "NAC", "MEF", "TWW", "KSR", "YUL", "LOP", "TIS", "SIH", "TUM"]],
    },
    {
        "id": "TCL",
        "name_tc": "東涌綫",
        "name_en": "Tung Chung Line",
        "color": "#f7941d",
        "offset": -6,
        "paths": [["HOK", "KOW", "OLY", "NAC", "LAK", "TSY", "SUN", "TUC"]],
    },
    {
        "id": "AEL",
        "name_tc": "機場快綫",
        "name_en": "Airport Express",
        "color": "#1c7670",
        "offset": 8,
        "paths": [["HOK", "KOW", "TSY", "AIR", "AWE"]],
    },
    {
        "id": "SIL",
        "name_tc": "南港島綫",
        "name_en": "South Island Line",
        "color": "#b5bd00",
        "offset": -8,
        "paths": [["ADM", "OCP", "WCH", "LET", "SOH"]],
    },
    {
        "id": "DRL",
        "name_tc": "迪士尼綫",
        "name_en": "Disneyland Resort Line",
        "color": "#f173ac",
        "offset": 3,
        "paths": [["SUN", "DIS"]],
    },
]


def distance_km(a: dict, b: dict) -> float:
    radius = 6371.0
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlat = math.radians(b["lat"] - a["lat"])
    dlng = math.radians(b["lng"] - a["lng"])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * radius * math.asin(min(1.0, math.sqrt(h)))


def build_network(cache: dict) -> dict:
    stations = []
    for line in LINES:
        seen: set[str] = set()
        for path in line["paths"]:
            for code in path:
                if code not in cache:
                    raise SystemExit(f"missing coordinates for {code}")
                if code in seen:
                    continue
                seen.add(code)
                current = next((item for item in stations if item["code"] == code), None)
                if current is None:
                    item = cache[code]
                    stations.append(
                        {
                            "code": code,
                            "name_tc": item["name_tc"],
                            "name_en": item["name_en"],
                            "lat": item["lat"],
                            "lng": item["lng"],
                            "lines": [line["id"]],
                        }
                    )
                elif line["id"] not in current["lines"]:
                    current["lines"].append(line["id"])
        for path in line["paths"]:
            for left, right in zip(path, path[1:]):
                km = distance_km(cache[left], cache[right])
                if km > 25:
                    raise SystemExit(f"{line['id']} {left}-{right} is {km:.1f} km, check the coordinates")
    stations.sort(key=lambda item: item["code"])
    lines = [dict(line) for line in LINES]
    if TRACK_PATH.exists():
        tracks = json.loads(TRACK_PATH.read_text(encoding="utf-8"))
        for line in lines:
            geometry = tracks.get(line["id"])
            if geometry is not None and len(geometry) != len(line["paths"]):
                raise SystemExit(f"{line['id']} track count does not match its paths")
            if geometry is not None:
                line["tracks"] = geometry
    return {"lines": lines, "stations": stations}


def build_cameras() -> list[dict]:
    request = urllib.request.Request(CAMERA_XML, headers={"User-Agent": "hk-smart-city-map/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = response.read()
    cameras = []
    for node in ET.fromstring(payload):
        fields = {child.tag: (child.text or "").strip() for child in node}
        cameras.append(
            {
                "key": fields["key"],
                "description": fields["description"],
                "region": fields["region"],
                "district": fields["district"],
                "lat": float(fields["latitude"]),
                "lng": float(fields["longitude"]),
            }
        )
    cameras.sort(key=lambda item: item["key"])
    keys = [item["key"] for item in cameras]
    if len(keys) != len(set(keys)):
        raise SystemExit("duplicate camera keys")
    return cameras


def main() -> None:
    cache = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    network = build_network(cache)
    cameras = build_cameras()
    NETWORK_PATH.write_text(json.dumps(network, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    CAMERAS_PATH.write_text(json.dumps(cameras, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"stations {len(network['stations'])} lines {len(network['lines'])} cameras {len(cameras)}")


if __name__ == "__main__":
    main()
