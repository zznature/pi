"""
Smoke-test LabSpec/IDS camera access through a COM/ActiveX automation object.

Run this on the lab Windows PC where LabSpec and the IDS camera software are
installed. The script defaults to registry discovery only. Pass --prog-id to
instantiate a component, and pass --call explicitly when you want to invoke a
method.
"""

from __future__ import annotations

import argparse
import json
import logging
import platform
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    import winreg
except ImportError:  # pragma: no cover - Windows-only script
    winreg = None

try:
    import pythoncom
    import win32com.client
except ImportError:  # pragma: no cover - depends on lab Windows env
    pythoncom = None
    win32com = None


KEYWORDS = (
    "LabSpec",
    "HORIBA",
    "Jobin",
    "Yvon",
    "IDS",
    "uEye",
    "ueye",
    "peak",
    "Camera",
    "ActiveX",
)


def setup_logger(log_path: Path) -> logging.Logger:
    logger = logging.getLogger("camera-com-test")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()

    formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")

    console = logging.StreamHandler()
    console.setFormatter(formatter)
    logger.addHandler(console)

    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    return logger


def iter_subkeys(root: Any, path: str):
    if winreg is None:
        return

    try:
        key = winreg.OpenKey(root, path)
    except OSError:
        return

    with key:
        index = 0
        while True:
            try:
                yield winreg.EnumKey(key, index)
            except OSError:
                break
            index += 1


def read_default_value(root: Any, path: str) -> str | None:
    if winreg is None:
        return None

    try:
        with winreg.OpenKey(root, path) as key:
            value, _ = winreg.QueryValueEx(key, None)
            return str(value)
    except OSError:
        return None


def discover_prog_ids() -> list[dict[str, str | None]]:
    roots = (
        (winreg.HKEY_CLASSES_ROOT, ""),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Classes"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Classes"),
        (winreg.HKEY_CURRENT_USER, r"Software\Classes"),
    )

    found: dict[tuple[str, str], dict[str, str | None]] = {}
    for root, base_path in roots:
        for name in iter_subkeys(root, base_path):
            if name in {"CLSID", "Interface", "TypeLib", "AppID", "Installer", "Licenses"}:
                continue
            if not any(keyword.lower() in name.lower() for keyword in KEYWORDS):
                continue

            clsid_path = rf"{base_path}\{name}\CLSID" if base_path else rf"{name}\CLSID"
            clsid = read_default_value(root, clsid_path)
            root_name = {
                winreg.HKEY_CLASSES_ROOT: "HKCR",
                winreg.HKEY_LOCAL_MACHINE: "HKLM",
                winreg.HKEY_CURRENT_USER: "HKCU",
            }.get(root, str(root))
            found[(name, root_name)] = {
                "prog_id": name,
                "clsid": clsid,
                "registry_root": root_name,
            }

    return sorted(found.values(), key=lambda item: (item["prog_id"] or "", item["registry_root"] or ""))


def create_com_object(prog_id: str, use_gencache: bool, logger: logging.Logger) -> Any:
    if pythoncom is None or win32com is None:
        raise RuntimeError("pywin32 is not installed. Run: pip install pywin32")

    pythoncom.CoInitialize()
    if use_gencache:
        logger.info("Creating COM object via EnsureDispatch: %s", prog_id)
        return win32com.client.gencache.EnsureDispatch(prog_id)

    logger.info("Creating COM object via Dispatch: %s", prog_id)
    return win32com.client.Dispatch(prog_id)


def list_members(com_object: Any, logger: logging.Logger) -> None:
    names = sorted(name for name in dir(com_object) if not name.startswith("_"))
    if names:
        logger.info("Visible Python members:")
        for name in names:
            logger.info("  %s", name)
    else:
        logger.warning("No visible Python members were returned by dir().")

    ole_obj = getattr(com_object, "_oleobj_", None)
    ole_repr = getattr(com_object, "_olerepr_", None)
    if ole_obj is not None:
        logger.info("COM _oleobj_ is available.")
    if ole_repr is not None:
        prop_get = sorted(getattr(ole_repr, "propMapGet", {}).keys())
        prop_put = sorted(getattr(ole_repr, "propMapPut", {}).keys())
        methods = sorted(getattr(ole_repr, "mapFuncs", {}).keys())
        if methods:
            logger.info("COM methods from type info:")
            for name in methods:
                logger.info("  %s", name)
        if prop_get:
            logger.info("Readable COM properties:")
            for name in prop_get:
                logger.info("  %s", name)
        if prop_put:
            logger.info("Writable COM properties:")
            for name in prop_put:
                logger.info("  %s", name)


def parse_call_args(raw: str) -> list[Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise argparse.ArgumentTypeError(f"--args must be a JSON array: {exc}") from exc
    if not isinstance(value, list):
        raise argparse.ArgumentTypeError("--args must be a JSON array, for example: '[100]'")
    return value


def call_method(com_object: Any, method_name: str, args: list[Any], logger: logging.Logger) -> None:
    logger.info("Calling method: %s(%s)", method_name, ", ".join(repr(arg) for arg in args))
    method = getattr(com_object, method_name)
    result = method(*args)
    logger.info("Method returned: %r", result)


def release_com_object(com_object: Any, logger: logging.Logger) -> None:
    if com_object is None:
        return
    try:
        del com_object
        if pythoncom is not None:
            pythoncom.CoUninitialize()
        logger.info("COM object released.")
    except Exception as exc:  # noqa: BLE001 - diagnostic script
        logger.warning("COM release failed/skipped: %s", exc)


def main() -> int:
    script_dir = Path(__file__).resolve().parent
    default_log = script_dir / f"camera_com_test_{datetime.now():%Y%m%d_%H%M%S}.log"

    parser = argparse.ArgumentParser(description="Test IDS/LabSpec camera COM/ActiveX access.")
    parser.add_argument("--prog-id", help="COM ProgID to instantiate, e.g. LabSpec.Application")
    parser.add_argument("--call", help="Method name to call explicitly.")
    parser.add_argument("--args", type=parse_call_args, default=[], help="JSON array of method args.")
    parser.add_argument("--list-members", action="store_true", help="List visible members after creation.")
    parser.add_argument("--skip-discovery", action="store_true", help="Skip registry ProgID discovery.")
    parser.add_argument("--use-gencache", action="store_true", help="Use win32com.client.gencache.EnsureDispatch.")
    parser.add_argument("--log-path", type=Path, default=default_log, help="Path to write the test log.")
    args = parser.parse_args()

    logger = setup_logger(args.log_path)
    logger.info("Python COM camera test started.")
    logger.info("Python: %s; Process bitness: %s-bit", sys.version.replace("\n", " "), platform.architecture()[0].replace("bit", ""))
    logger.info("Log file: %s", args.log_path)

    if sys.platform != "win32":
        logger.error("COM/ActiveX testing requires Windows.")
        return 2
    if winreg is None:
        logger.error("winreg is unavailable; this script must run on Windows Python.")
        return 2
    if pythoncom is None or win32com is None:
        logger.error("pywin32 is not installed. Run: pip install pywin32")
        return 2

    if not args.skip_discovery:
        logger.info("Scanning registered COM/ActiveX ProgIDs related to LabSpec/IDS/uEye/peak/camera...")
        candidates = discover_prog_ids()
        if not candidates:
            logger.warning("No obvious camera/LabSpec COM ProgID found in registry.")
        else:
            logger.info("Found %d candidate ProgID(s):", len(candidates))
            for item in candidates:
                logger.info("  %-45s clsid=%s root=%s", item["prog_id"], item["clsid"], item["registry_root"])

    if not args.prog_id:
        logger.info("No --prog-id supplied. Discovery finished.")
        return 0

    com_object = None
    try:
        com_object = create_com_object(args.prog_id, args.use_gencache, logger)
        logger.info("Created COM object for %s.", args.prog_id)

        if args.list_members:
            list_members(com_object, logger)

        if args.call:
            call_method(com_object, args.call, args.args, logger)
        else:
            logger.info("No --call supplied. Object creation test only; no camera method was invoked.")

    except Exception as exc:  # noqa: BLE001 - diagnostic script
        logger.exception("Test failed: %s", exc)
        return 1
    finally:
        release_com_object(com_object, logger)

    logger.info("Python COM camera test finished.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
