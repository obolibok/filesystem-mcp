"""Verify live bundle artifacts against independent synthetic expectations."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path, PurePosixPath
from zipfile import ZipFile


SMALL = {
    "unicode-original.zip": {
        "size": 703,
        "sha256": "4e729b848906db06641b1ef60e752ae654b5705e92a881cd68319a6538a7fe02",
    },
    "legacy-original.xls": {
        "size": 5632,
        "sha256": "db5c5cbd862f422b42085e3ac0936bb200a7a32cdbf3fce503b3bc76f476fc91",
    },
}
VOLUME_PATHS = [
    "volume/alpha/shared.bin",
    "volume/beta/shared.bin",
    "volume/gamma/original-03.bin",
    "volume/deep/one/original-04.bin",
    "volume/deep/two/Größe-Антенна-05.bin",
    "volume/кириллица/original-06.bin",
    "volume/omega-Ω/original-07.bin",
]
CONTROL_PATH = "volume/control/not-selected.bin"
FILE_BYTES = 1024 * 1024
NESTED_ZIP_ENTRIES = {"README.txt", "data/Größe-Антенна.txt", "payload.bin"}
XLS_CELLS = {
    "Control!A1": "SCHWARZBECK-ORIGINALS-002",
    "Control!B2": 4242,
    "Control!C3": 12.5,
    "Control!D4": "Größe Антенна",
    "Control!E5": "2026-09-19T12:34:56",
    "Контроль!A1": "КОНТРОЛЬ-Ω",
    "Контроль!B3": -7,
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def deterministic_record(seed: int) -> dict[str, int | str]:
    digest = hashlib.sha256()
    remaining = FILE_BYTES
    block = 0
    while remaining:
        value = hashlib.sha256(f"{seed}:{block}".encode()).digest()
        chunk = value[: min(len(value), remaining)]
        digest.update(chunk)
        remaining -= len(chunk)
        block += 1
    return {"size": FILE_BYTES, "sha256": digest.hexdigest()}


def expected_for(case: str) -> tuple[dict[str, dict[str, int | str]], bool]:
    if case == "small":
        return SMALL, True
    if case == "volume":
        return {path: deterministic_record(index) for index, path in enumerate(VOLUME_PATHS)}, True
    if case == "partial":
        return {
            "unicode-original.zip": SMALL["unicode-original.zip"],
            "missing-control.bin": {"status": "missing"},
        }, False
    raise ValueError(f"Unsupported case: {case}")


def safe_relative(entry_name: str) -> str:
    entry = PurePosixPath(entry_name)
    if entry.is_absolute() or len(entry.parts) < 2 or entry.parts[0] != "files":
        raise RuntimeError(f"Unexpected archive entry: {entry_name}")
    relative = PurePosixPath(*entry.parts[1:])
    if any(part in ("", ".", "..") for part in relative.parts):
        raise RuntimeError(f"Unsafe archive entry: {entry_name}")
    return relative.as_posix()


def a1_coordinates(cell_ref: str) -> tuple[int, int]:
    match = re.fullmatch(r"([A-Z]+)([1-9][0-9]*)", cell_ref)
    if match is None:
        raise ValueError(f"Unsupported A1 reference: {cell_ref}")
    column = 0
    for char in match.group(1):
        column = column * 26 + ord(char) - ord("A") + 1
    return int(match.group(2)) - 1, column - 1


def xls_value(workbook, address: str):
    import xlrd

    sheet_name, cell_ref = address.split("!", 1)
    row, column = a1_coordinates(cell_ref)
    cell = workbook.sheet_by_name(sheet_name).cell(row, column)
    if cell.ctype == xlrd.XL_CELL_DATE:
        value: datetime = xlrd.xldate_as_datetime(cell.value, workbook.datemode)
        return value.replace(microsecond=0).isoformat()
    if cell.ctype == xlrd.XL_CELL_NUMBER and cell.value.is_integer():
        return int(cell.value)
    return cell.value


def verify(args: argparse.Namespace) -> dict:
    expected, expected_complete = expected_for(args.case)
    bundle = json.loads(args.bundle_manifest.read_text(encoding="utf-8"))
    if bundle.get("schema") != "filesystem-mcp.bundle-manifest" or bundle.get("version") != 1:
        raise RuntimeError("Unexpected bundle manifest schema/version")
    if bundle.get("jobId") != args.expected_job_id:
        raise RuntimeError("Manifest jobId does not match the requested live job")
    root = bundle.get("root")
    if not isinstance(root, dict) or set(root) != {"id"} or not root.get("id"):
        raise RuntimeError("Manifest root must contain only a non-empty id")
    if bundle.get("complete") is not expected_complete:
        raise RuntimeError("Unexpected bundle completeness")
    records = bundle.get("files")
    if not isinstance(records, list):
        raise RuntimeError("Manifest files is not a list")
    by_path = {record.get("relativePath"): record for record in records}
    if None in by_path or len(by_path) != len(records) or set(by_path) != set(expected):
        raise RuntimeError("Manifest file set differs from independent expectations")

    counters = bundle.get("counters", {})
    expected_included = 1 if args.case == "partial" else len(expected)
    expected_skipped = 1 if args.case == "partial" else 0
    if (
        counters.get("requested") != len(expected)
        or counters.get("included") != expected_included
        or counters.get("skipped") != expected_skipped
        or counters.get("missing") != expected_skipped
    ):
        raise RuntimeError("Manifest counters differ from the expected case")

    if args.case == "volume":
        policy = bundle.get("policy", {})
        if (
            policy.get("maxRawPartBytes") != 2097152
            or policy.get("maxZipBytes") != 2097152
            or policy.get("maxDeliveryBytes") != 2097152
            or policy.get("effectiveZipDeliveryBytes") != 2097152
            or policy.get("maxFileSizeBytes", 0) < FILE_BYTES
        ):
            raise RuntimeError("Volume case effective caps differ from the required 2 MiB profile")
        if CONTROL_PATH in by_path:
            raise RuntimeError("Unselected control appeared in the manifest")

    extracted: dict[str, bytes] = {}
    entry_parts: dict[str, dict[str, str]] = {}
    part_checks = []
    parts = bundle.get("parts")
    if not isinstance(parts, list) or not parts:
        raise RuntimeError("Bundle produced no ZIP parts")
    part_ids = [part.get("artifactId") for part in parts]
    part_names = [part.get("name") for part in parts]
    if len(part_ids) != len(set(part_ids)) or len(part_names) != len(set(part_names)):
        raise RuntimeError("Duplicate bundle part identity")
    for part in parts:
        path = args.artifacts_dir / part["name"]
        content = path.read_bytes()
        if len(content) != part["zipBytes"] or sha256(content) != part["sha256"]:
            raise RuntimeError(f"Bundle part size/hash mismatch: {part['name']}")
        with ZipFile(path, "r") as archive:
            corrupt = archive.testzip()
            if corrupt is not None:
                raise RuntimeError(f"ZIP CRC failed for {corrupt}")
            names = archive.namelist()
            if len(names) != len(set(names)):
                raise RuntimeError(f"Duplicate ZIP entry in {part['name']}")
            raw_bytes = 0
            for entry_name in names:
                relative_path = safe_relative(entry_name)
                if relative_path in extracted:
                    raise RuntimeError(f"Original repeated across parts: {relative_path}")
                original = archive.read(entry_name)
                raw_bytes += len(original)
                extracted[relative_path] = original
                entry_parts[relative_path] = {
                    "artifactId": part["artifactId"],
                    "name": part["name"],
                    "archiveEntry": entry_name,
                }
            if raw_bytes != part["rawBytes"] or len(names) != part["fileCount"]:
                raise RuntimeError(f"Bundle part counters mismatch: {part['name']}")
        part_checks.append(
            {
                "artifactId": part["artifactId"],
                "name": part["name"],
                "bytes": len(content),
                "sha256": sha256(content),
                "entries": len(names),
                "crc": "PASS",
            }
        )

    expected_included_paths = {
        path for path, record in expected.items() if record.get("status") != "missing"
    }
    if set(extracted) != expected_included_paths:
        raise RuntimeError("Extracted original set differs from independent expectations")
    original_checks = {}
    for relative_path, expectation in expected.items():
        record = by_path[relative_path]
        if expectation.get("status") == "missing":
            if record.get("status") != "missing" or "actual" in record:
                raise RuntimeError("Missing selector was not reported as missing")
            original_checks[relative_path] = {"status": "missing", "verified": True}
            continue
        original = extracted[relative_path]
        actual = {"size": len(original), "sha256": sha256(original)}
        if actual != expectation or record.get("status") != "included" or record.get("actual") != actual:
            raise RuntimeError(f"Original bytes/manifest mismatch: {relative_path}")
        expected_provenance = {
            "artifactId": record.get("partArtifactId"),
            "name": record.get("partName"),
            "archiveEntry": record.get("archiveEntry"),
        }
        if entry_parts.get(relative_path) != expected_provenance:
            raise RuntimeError(f"Original provenance mismatch: {relative_path}")
        original_checks[relative_path] = {**actual, "status": "PASS"}

    repeated_fetch = None
    if args.repeat is not None:
        repeated = args.repeat.read_bytes()
        matches = [
            part for part in parts if (args.artifacts_dir / part["name"]).read_bytes() == repeated
        ]
        if len(matches) != 1:
            raise RuntimeError("Repeated fetch does not byte-match exactly one bundle part")
        repeated_fetch = {
            "name": matches[0]["name"],
            "bytes": len(repeated),
            "sha256": sha256(repeated),
            "status": "PASS",
        }
    elif args.case != "partial":
        raise RuntimeError("Positive live cases require a separately materialized repeated fetch")

    nested_zip = {}
    xls_cells = {}
    if args.case == "small":
        nested_path = args.delivery_dir / "unicode-original.zip"
        nested_path.parent.mkdir(parents=True, exist_ok=True)
        nested_path.write_bytes(extracted["unicode-original.zip"])
        with ZipFile(nested_path, "r") as archive:
            corrupt = archive.testzip()
            if corrupt is not None or set(archive.namelist()) != NESTED_ZIP_ENTRIES:
                raise RuntimeError("Nested ZIP entries/CRC mismatch")
            nested_zip = {
                name: {"bytes": len(archive.read(name)), "status": "PASS"}
                for name in archive.namelist()
            }
        xls_path = args.delivery_dir / "legacy-original.xls"
        xls_path.write_bytes(extracted["legacy-original.xls"])
        try:
            import xlrd
        except ImportError as error:
            raise RuntimeError("xlrd is required to verify the BIFF8 XLS") from error
        workbook = xlrd.open_workbook(xls_path, on_demand=True)
        try:
            for address, expected_value in XLS_CELLS.items():
                value = xls_value(workbook, address)
                if value != expected_value:
                    raise RuntimeError(f"XLS cell mismatch at {address}")
                xls_cells[address] = {"value": value, "status": "PASS"}
        finally:
            workbook.release_resources()

    return {
        "schemaVersion": 1,
        "case": args.case,
        "overall_pass": True,
        "validation_errors": [],
        "jobId": bundle["jobId"],
        "rootId": root["id"],
        "complete": bundle["complete"],
        "counters": counters,
        "policy": bundle.get("policy"),
        "parts": part_checks,
        "originals": original_checks,
        "provenance": "PASS",
        "nestedZip": nested_zip,
        "xlsCells": xls_cells,
        "repeatedFetch": repeated_fetch,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", choices=("small", "volume", "partial"), required=True)
    parser.add_argument("--bundle-manifest", type=Path, required=True)
    parser.add_argument("--artifacts-dir", type=Path, required=True)
    parser.add_argument("--delivery-dir", type=Path, required=True)
    parser.add_argument("--expected-job-id", required=True)
    parser.add_argument("--repeat", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        report = verify(args)
    except Exception as error:
        report = {
            "schemaVersion": 1,
            "case": args.case,
            "overall_pass": False,
            "validation_errors": [f"{type(error).__name__}: {error}"],
        }
        args.output.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(args.output)
        raise SystemExit(1) from error
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(args.output)


if __name__ == "__main__":
    main()
