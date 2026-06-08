"""
Probe LabSpec video-related COM methods and VideoID behavior.

This script is intentionally diagnostic. It does not read camera pixels by
itself; it checks whether the LabSpec automation object exposes a documented
or discoverable path from VideoID to an image export/buffer API.
"""

from __future__ import annotations

import argparse
import logging
import platform
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    import pythoncom
    import win32com.client
except ImportError:  # pragma: no cover - Windows lab host only
    pythoncom = None
    win32com = None


START_VIDEO = 0
STOP_VIDEO = 1
GET_VIDEO_ID = 2
START_EXTENDED_VIDEO = 3
GET_ACTIVE_CAMERA = 4
SET_ACTIVE_CAMERA = 10

VIDEO_RELATED_TERMS = (
    "video",
    "image",
    "bitmap",
    "bmp",
    "picture",
    "snapshot",
    "frame",
    "camera",
    "save",
    "export",
    "file",
    "data",
    "buffer",
    "extended",
)


def setup_logger(log_path: Path) -> logging.Logger:
    logger = logging.getLogger("labspec-video-probe")
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


def connect_labspec(
    prog_id: str,
    attach_running: bool,
    attach_only: bool,
    use_gencache: bool,
    logger: logging.Logger,
) -> Any:
    if pythoncom is None or win32com is None:
        raise RuntimeError("pywin32 is required. Install with: pip install pywin32")

    pythoncom.CoInitialize()
    if attach_running:
        try:
            logger.info("Attaching to running COM object: %s", prog_id)
            return win32com.client.GetActiveObject(prog_id)
        except Exception as exc:  # noqa: BLE001 - diagnostic fallback
            logger.warning("GetActiveObject failed: %s", exc)
            if attach_only:
                raise RuntimeError(f"No running LabSpec COM object found for {prog_id}") from exc

    if use_gencache:
        logger.info("Creating COM object via EnsureDispatch: %s", prog_id)
        return win32com.client.gencache.EnsureDispatch(prog_id)

    logger.info("Creating COM object via Dispatch: %s", prog_id)
    return win32com.client.Dispatch(prog_id)


def release_com() -> None:
    if pythoncom is not None:
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass


def call_and_log(lab_spec: Any, method_name: str, *args: Any, logger: logging.Logger) -> Any:
    logger.info("Calling %s(%s)", method_name, ", ".join(repr(arg) for arg in args))
    method = getattr(lab_spec, method_name)
    result = method(*args)
    logger.info("%s returned: %r", method_name, result)
    return result


def get_typeinfo_names(lab_spec: Any) -> list[str]:
    names: set[str] = set()
    for name in dir(lab_spec):
        if not name.startswith("_"):
            names.add(name)

    ole_repr = getattr(lab_spec, "_olerepr_", None)
    if ole_repr is not None:
        for attr in ("mapFuncs", "propMapGet", "propMapPut"):
            mapping = getattr(ole_repr, attr, None)
            if mapping:
                names.update(str(key) for key in mapping.keys())

    ole_obj = getattr(lab_spec, "_oleobj_", None)
    if ole_obj is not None:
        try:
            type_info = ole_obj.GetTypeInfo()
            type_attr = type_info.GetTypeAttr()
            for index in range(type_attr.cFuncs):
                func_desc = type_info.GetFuncDesc(index)
                func_names = type_info.GetNames(func_desc.memid)
                if func_names:
                    names.add(str(func_names[0]))
            for index in range(type_attr.cVars):
                var_desc = type_info.GetVarDesc(index)
                var_names = type_info.GetNames(var_desc.memid)
                if var_names:
                    names.add(str(var_names[0]))
        except Exception:
            pass
    return sorted(names, key=str.lower)


def log_video_related_members(lab_spec: Any, logger: logging.Logger) -> list[str]:
    names = get_typeinfo_names(lab_spec)
    related = [
        name
        for name in names
        if any(term in name.lower() for term in VIDEO_RELATED_TERMS)
    ]

    logger.info("Visible COM member count: %d", len(names))
    if related:
        logger.info("Video/image/export-related visible members:")
        for name in related:
            logger.info("  %s", name)
    else:
        logger.warning("No visible COM members matched video/image/export terms.")
    return related


def probe_video(lab_spec: Any, args: argparse.Namespace, logger: logging.Logger) -> None:
    if args.list_members:
        log_video_related_members(lab_spec, logger)

    if args.active_camera:
        try:
            call_and_log(lab_spec, "Video", GET_ACTIVE_CAMERA, logger=logger)
        except Exception as exc:  # noqa: BLE001 - diagnostic script
            logger.exception("Video(GET_ACTIVE_CAMERA) failed: %s", exc)

    if args.set_active_camera is not None:
        mode = SET_ACTIVE_CAMERA + args.set_active_camera
        call_and_log(lab_spec, "Video", mode, logger=logger)

    if args.start_video:
        call_and_log(lab_spec, "Video", START_VIDEO, logger=logger)

    if args.start_extended_video:
        call_and_log(lab_spec, "Video", START_EXTENDED_VIDEO, logger=logger)

    last_video_id: Any = None
    if args.poll_video_id or args.save_video_id:
        logger.info(
            "Polling Video(GET_VIDEO_ID) for %.3fs every %.3fs",
            args.poll_seconds,
            args.poll_interval_s,
        )
        deadline = time.monotonic() + args.poll_seconds
        poll_index = 0
        while time.monotonic() <= deadline:
            poll_index += 1
            try:
                video_id = lab_spec.Video(GET_VIDEO_ID)
                last_video_id = video_id
                logger.info("VideoID poll %d: %r", poll_index, video_id)
                if args.save_video_id and int(video_id) > 0:
                    break
            except Exception as exc:  # noqa: BLE001 - diagnostic script
                logger.exception("Video(GET_VIDEO_ID) poll %d failed: %s", poll_index, exc)
                break
            time.sleep(args.poll_interval_s)

    if args.save_video_id:
        if last_video_id is None or int(last_video_id) <= 0:
            raise RuntimeError("Cannot save video image because no positive VideoID was returned.")
        output_path = args.save_path
        if output_path is None:
            output_path = Path("captures") / f"labspec_video_probe_{datetime.now():%Y%m%d_%H%M%S}.{args.save_format}"
        output_path = output_path.resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        call_and_log(lab_spec, "Save", int(last_video_id), str(output_path), args.save_format, logger=logger)
        logger.info("Requested LabSpec.Save for VideoID %s to %s", last_video_id, output_path)

    if args.stop_video:
        call_and_log(lab_spec, "Video", STOP_VIDEO, logger=logger)


def main() -> int:
    script_dir = Path(__file__).resolve().parent
    default_log = script_dir / f"labspec_video_probe_{datetime.now():%Y%m%d_%H%M%S}.log"

    parser = argparse.ArgumentParser(description="Probe LabSpec VideoID COM behavior.")
    parser.add_argument("--prog-id", default="LabSpec6.S", help="LabSpec COM ProgID.")
    parser.add_argument(
        "--no-attach-running",
        action="store_true",
        help="Do not try GetActiveObject before creating a COM object.",
    )
    parser.add_argument(
        "--attach-only",
        action="store_true",
        help="Fail instead of creating LabSpec when no running COM object is available.",
    )
    parser.add_argument("--use-gencache", action="store_true", help="Use EnsureDispatch.")
    parser.add_argument("--log-path", type=Path, default=default_log, help="Log output path.")
    parser.add_argument("--list-members", action="store_true", help="List video/image/export-related COM members.")
    parser.add_argument("--active-camera", action="store_true", help="Call Video(GET_ACTIVE_CAMERA).")
    parser.add_argument("--set-active-camera", type=int, help="Call Video(SET_ACTIVE_CAMERA + camera_id).")
    parser.add_argument("--start-video", action="store_true", help="Call Video(START_VIDEO).")
    parser.add_argument("--start-extended-video", action="store_true", help="Call Video(START_EXTENDED_VIDEO).")
    parser.add_argument("--poll-video-id", action="store_true", help="Poll Video(GET_VIDEO_ID).")
    parser.add_argument("--poll-seconds", type=float, default=3.0, help="VideoID polling duration.")
    parser.add_argument("--poll-interval-s", type=float, default=0.2, help="VideoID polling interval.")
    parser.add_argument(
        "--save-video-id",
        action="store_true",
        help="After a positive VideoID is available, call LabSpec.Save(VideoID, path, format).",
    )
    parser.add_argument("--save-path", type=Path, help="Output path for --save-video-id.")
    parser.add_argument("--save-format", default="tif", help="LabSpec Save format, for example ngv, tif, jpg.")
    parser.add_argument("--stop-video", action="store_true", help="Call Video(STOP_VIDEO) before exit.")
    args = parser.parse_args()

    logger = setup_logger(args.log_path)
    logger.info("LabSpec video COM probe started.")
    logger.info(
        "Python: %s; process bitness: %s",
        sys.version.replace("\n", " "),
        platform.architecture()[0],
    )
    logger.info("Log file: %s", args.log_path)

    if sys.platform != "win32":
        logger.error("LabSpec COM probing requires Windows.")
        return 2
    if pythoncom is None or win32com is None:
        logger.error("pywin32 is not installed. Run: pip install pywin32")
        return 2

    lab_spec = None
    try:
        lab_spec = connect_labspec(
            args.prog_id,
            attach_running=not args.no_attach_running,
            attach_only=args.attach_only,
            use_gencache=args.use_gencache,
            logger=logger,
        )
        logger.info("LabSpec COM object ready.")
        probe_video(lab_spec, args, logger)
    except Exception as exc:  # noqa: BLE001 - diagnostic script
        logger.exception("Probe failed: %s", exc)
        return 1
    finally:
        lab_spec = None
        release_com()

    logger.info("LabSpec video COM probe finished.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
