"""Discover whether LabSpec.exe exposes a usable COM context to external processes.

Run while LabSpec is open. The script:
  1. Enumerates every moniker currently in the Running Object Table.
  2. Scans HKCR / HKLM-Classes for ProgIDs whose name contains 'labspec' / 'horiba'.
  3. Tries GetActiveObject on each candidate ProgID, then issues smoke calls that
     are known to hang on the empty NFActiveX shell (Message, ConvertUnit, GetAcqID).

If a candidate returns from those smoke calls in milliseconds, that ProgID is the
live LabSpec engine and the external acquirer should attach via GetActiveObject
instead of CoCreateInstance.
"""

from __future__ import annotations

import argparse
import platform
import sys
import time
import winreg
from typing import Any

try:
    import pythoncom
    import win32com.client
except ImportError:
    sys.stderr.write("pywin32 is required: pip install pywin32\n")
    raise


KNOWN_PROG_IDS: tuple[str, ...] = (
    "LabSpec6.S",
    "LabSpec6.Application",
    "LabSpec6",
    "LabSpec.Application",
    "LabSpec",
    "Horiba.LabSpec",
    "NFACTIVEX.NFActiveXCtrl.1",
)

SMOKE_BUDGET_S = 2.0


def enum_rot() -> list[str]:
    pythoncom.CoInitialize()
    rot = pythoncom.GetRunningObjectTable()
    bind_ctx = pythoncom.CreateBindCtx(0)
    names: list[str] = []
    for moniker in rot:
        try:
            names.append(moniker.GetDisplayName(bind_ctx, None))
        except Exception as exc:  # noqa: BLE001
            names.append(f"<unreadable moniker: {exc}>")
    return names


def scan_registry_for_labspec() -> list[str]:
    candidates: set[str] = set()
    for hive in (winreg.HKEY_CLASSES_ROOT, winreg.HKEY_LOCAL_MACHINE):
        root = r"" if hive == winreg.HKEY_CLASSES_ROOT else r"SOFTWARE\Classes"
        try:
            with winreg.OpenKey(hive, root) as base:
                index = 0
                while True:
                    try:
                        name = winreg.EnumKey(base, index)
                    except OSError:
                        break
                    index += 1
                    lower = name.lower()
                    if "labspec" in lower or "horiba" in lower or "nfactivex" in lower:
                        candidates.add(name)
        except OSError:
            continue
    return sorted(candidates)


def try_attach(prog_id: str) -> Any | None:
    try:
        return win32com.client.GetActiveObject(prog_id)
    except Exception:
        return None


def smoke_call(obj: Any, label: str) -> dict[str, str]:
    """Call methods that are known to hang on the empty NFActiveX shell.

    A live LabSpec context returns from each within milliseconds. The empty shell
    blocks indefinitely, so we run them with a wall-clock budget per call.
    """
    results: dict[str, str] = {}
    probes: tuple[tuple[str, tuple[Any, ...]], ...] = (
        ("TickCount", ()),
        ("Message", ("[discover] context probe", 6)),
        ("ConvertUnit", (532.0, 1)),
        ("GetAcqID", ()),
    )
    for method, args in probes:
        started = time.monotonic()
        try:
            ret = getattr(obj, method)(*args)
            elapsed = time.monotonic() - started
            verdict = "OK" if elapsed < SMOKE_BUDGET_S else "SLOW"
            results[method] = f"{verdict} ret={ret!r} elapsed={elapsed:.3f}s"
        except Exception as exc:  # noqa: BLE001
            elapsed = time.monotonic() - started
            results[method] = f"ERR elapsed={elapsed:.3f}s: {exc}"
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--prog-id",
        action="append",
        default=None,
        help="Extra ProgID to probe (may be repeated).",
    )
    args = parser.parse_args()
    extra: list[str] = list(args.prog_id or [])

    if sys.platform != "win32":
        print("ERROR: this script requires Windows.", file=sys.stderr)
        return 2

    print(f"Python: {sys.version.split()[0]}  bitness: {platform.architecture()[0]}")
    print()

    print("=== Running Object Table snapshot ===")
    rot_names = enum_rot()
    if not rot_names:
        print("  (ROT is empty)")
    for name in rot_names:
        print(f"  {name}")
    print()

    print("=== Registry ProgID candidates ===")
    reg_candidates = scan_registry_for_labspec()
    for name in reg_candidates:
        print(f"  {name}")
    if not reg_candidates:
        print("  (none matched labspec/horiba/nfactivex)")
    print()

    candidates = list(dict.fromkeys([*KNOWN_PROG_IDS, *reg_candidates, *extra]))
    print("=== GetActiveObject + smoke calls ===")
    for prog_id in candidates:
        obj = try_attach(prog_id)
        if obj is None:
            print(f"  {prog_id}: not in ROT")
            continue
        print(f"  {prog_id}: ATTACHED  type={type(obj).__name__}")
        for method, line in smoke_call(obj, prog_id).items():
            print(f"    {method}: {line}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
