"""MC.NewtonLT-06 multi-channel XYZ stage controller."""

from __future__ import annotations

import re
import time

import serial

from stage.exceptions import StageCommandError, StageConnectionError, StageTimeoutError
from stage.models import StagePosition


class MCNewtonXYZStageController:
    """XYZStage implementation for one MC.Newton controller with per-axis channels."""

    def __init__(
        self,
        port: str,
        *,
        baudrate: int = 115200,
        x_channel: int = 1,
        y_channel: int = 2,
        z_channel: int = 3,
        read_timeout: float = 1.0,
        default_cmd_wait_ms: float = 5.0,
        idn_wait_ms: float = 100.0,
        idn_retries: int = 3,
        move_cmd_wait_ms: float = 30.0,
        channel_switch_wait_ms: float = 100.0,
        disable_on_disconnect: bool = True,
        exclusive_channel: bool = True,
        x_target_tolerance_um: float = 1.0,
        y_target_tolerance_um: float = 1.0,
        z_target_tolerance_um: float = 1.0,
        stability_tolerance_um: float = 0.2,
        settle_correction_attempts: int = 10,
        settle_correction_threshold_um: float = 100.0,
        response_collect_ms: float = 50.0,
        segmented_move_threshold_um: float = 10.0,
        segmented_move_step_um: float = 5.0,
    ) -> None:
        self._port = port
        self._baudrate = baudrate
        self._channels = {
            "x": int(x_channel),
            "y": int(y_channel),
            "z": int(z_channel),
        }
        self._read_timeout = read_timeout
        self._default_cmd_wait_ms = default_cmd_wait_ms
        self._idn_wait_ms = idn_wait_ms
        self._idn_retries = idn_retries
        self._move_cmd_wait_ms = move_cmd_wait_ms
        self._channel_switch_wait_ms = channel_switch_wait_ms
        self._disable_on_disconnect = disable_on_disconnect
        self._exclusive_channel = exclusive_channel
        self._target_tolerances_um = {
            "x": float(x_target_tolerance_um),
            "y": float(y_target_tolerance_um),
            "z": float(z_target_tolerance_um),
        }
        self._stability_tolerance_um = float(stability_tolerance_um)
        self._settle_correction_attempts = int(settle_correction_attempts)
        self._settle_correction_threshold_um = float(settle_correction_threshold_um)
        self._response_collect_ms = float(response_collect_ms)
        self._segmented_move_threshold_um = float(segmented_move_threshold_um)
        self._segmented_move_step_um = float(segmented_move_step_um)
        self._axis_motion_profiles: dict[str, tuple[str, str, int, int]] = {
            "x": ("mm", "slide", 30, 2000),
            "y": ("mm", "slide", 30, 2000),
            "z": ("mm", "step", 30, 500),
        }
        self._active_motion_profile: tuple[str, str, int, int] | None = None
        self._ser = None
        self._connected = False
        self._enabled_channels: set[int] = set()
        self._last_targets_um: dict[str, float] = {}
        self._last_pulse_axes: set[str] = set()

    def __enter__(self) -> "MCNewtonXYZStageController":
        self.connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.disconnect()

    def connect(self) -> None:
        self._ser = serial.Serial(
            port=self._port,
            baudrate=self._baudrate,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE,
            timeout=self._read_timeout,
        )

        idn = ""
        for _ in range(max(1, self._idn_retries)):
            idn = self._send("[*IDN?]", wait_ms=self._idn_wait_ms)
            if idn and "Newton" in idn:
                break
        if not idn or "Newton" not in idn:
            self._ser.close()
            raise StageConnectionError(f"IDN check failed: unexpected response '{idn}'")

        self._connected = True

    def configure_motion(
        self,
        *,
        voltage_v: int | None = None,
        frequency_hz: int | None = None,
        mode: str | None = None,
        units: str | None = None,
    ) -> None:
        """Configure controller motion parameters from the MC.Newton command set."""

        if units is not None:
            normalized_units = units.strip().lower()
            if normalized_units not in {"mm", "angle"}:
                raise ValueError("units must be 'mm' or 'angle'.")
            self._send(f"[changeunits:{normalized_units}]")

        if mode is not None:
            normalized_mode = mode.strip().lower()
            if normalized_mode == "slide":
                self._send("[-slid-]")
            elif normalized_mode == "step":
                self._send("[-step-]")
            else:
                raise ValueError("mode must be 'slide' or 'step'.")

        if voltage_v is not None:
            voltage = int(voltage_v)
            if voltage < 0 or voltage > 999:
                raise ValueError("voltage_v must be between 0 and 999.")
            self._send(f"[volt:+{voltage:03d}V]")

        if frequency_hz is not None:
            frequency = int(frequency_hz)
            if frequency <= 0 or frequency > 99999:
                raise ValueError("frequency_hz must be between 1 and 99999.")
            self._send(f"[freq:{frequency:05d}Hz]")

    def apply_fast_move_profile(
        self,
        *,
        voltage_v: int = 30,
        frequency_hz: int = 2000,
        mode: str = "slide",
        units: str = "mm",
        z_voltage_v: int = 30,
        z_frequency_hz: int = 500,
        z_mode: str = "step",
    ) -> None:
        """Apply movement profiles.

        The programming guide example uses 500 Hz; this profile uses 2000 Hz
        for X/Y, while Z uses a conservative step profile because its positive
        motion underperformed with the XY slide profile.
        """

        if voltage_v > 30:
            raise ValueError("fast move profile voltage_v must not exceed 30 V.")
        if frequency_hz > 2000:
            raise ValueError("fast move profile frequency_hz must not exceed 2000 Hz.")
        if z_voltage_v > 30:
            raise ValueError("Z move profile z_voltage_v must not exceed 30 V.")
        if z_frequency_hz > 2000:
            raise ValueError("Z move profile z_frequency_hz must not exceed 2000 Hz.")

        xy_profile = (units, mode, int(voltage_v), int(frequency_hz))
        z_profile = (units, z_mode, int(z_voltage_v), int(z_frequency_hz))
        self._axis_motion_profiles["x"] = xy_profile
        self._axis_motion_profiles["y"] = xy_profile
        self._axis_motion_profiles["z"] = z_profile
        self._apply_axis_motion_profile("x")

    def disconnect(self) -> None:
        if not self._connected:
            return
        if self._disable_on_disconnect:
            for channel in sorted(self._enabled_channels):
                try:
                    self._send(f"[ch{channel}:0]")
                except Exception:
                    pass
        if self._ser is not None:
            self._ser.close()
        self._connected = False

    def get_position_um(self) -> StagePosition:
        return StagePosition(
            x_um=self.get_axis_position_um("x"),
            y_um=self.get_axis_position_um("y"),
            z_um=self.get_axis_position_um("z"),
        )

    def enable_only_axis(self, axis: str) -> None:
        """Enable one axis channel and disable all other known stage channels."""

        self._select_axis(axis, disable_others=True)

    def disable_all_axes(self) -> None:
        """Disable every stage channel currently known to be enabled."""

        for channel in sorted(self._enabled_channels):
            self._send(f"[ch{channel}:0]")
            self._enabled_channels.discard(channel)

    def get_axis_position_um(self, axis: str, *, preserve_enabled_channels: bool = False) -> float:
        disable_others = False if preserve_enabled_channels else None
        self._select_axis(axis, disable_others=disable_others)
        response = self._send("[check:pos?]")
        try:
            return self._parse_position_um(response)
        except (ValueError, AttributeError) as exc:
            raise StageCommandError(f"Cannot parse {axis.upper()} position response: '{response}'") from exc

    def move_absolute_um(
        self,
        *,
        x_um: float | None = None,
        y_um: float | None = None,
        z_um: float | None = None,
    ) -> None:
        targets = {"x": x_um, "y": y_um, "z": z_um}
        self._last_targets_um = {}
        for axis, target_um in targets.items():
            if target_um is None:
                continue
            self._move_axis_absolute_um(axis, float(target_um))

    def move_to_position_um(
        self,
        target: StagePosition,
        *,
        timeout_ms: int,
    ) -> StagePosition:
        """Move all axes to target, wait until settled, and return final position."""
        self.move_absolute_um(
            x_um=target.x_um,
            y_um=target.y_um,
            z_um=target.z_um,
        )
        self.wait_settled(timeout_ms)
        return self.get_position_um()

    def move_relative_um(
        self,
        *,
        dx_um: float = 0.0,
        dy_um: float = 0.0,
        dz_um: float = 0.0,
    ) -> None:
        shifts = {"x": dx_um, "y": dy_um, "z": dz_um}
        self._last_targets_um = {}
        for axis, delta_um in shifts.items():
            if delta_um == 0:
                continue
            current_um = self.get_axis_position_um(axis)
            self._move_axis_absolute_um(axis, current_um + float(delta_um))

    def wait_settled(self, timeout_ms: int, axes: set[str] | None = None) -> None:
        if not self._last_targets_um:
            return

        target_axes = self._normalize_wait_axes(axes)
        t_start = time.monotonic()
        corrections = {axis: 0 for axis in target_axes}
        previous = {axis: self.get_axis_position_um(axis, preserve_enabled_channels=True) for axis in target_axes}
        while True:
            time.sleep(0.050)
            current = {axis: self.get_axis_position_um(axis, preserve_enabled_channels=True) for axis in target_axes}

            all_stable = all(
                abs(current[axis] - previous[axis]) < self._stability_tolerance_um
                for axis in current
            )
            all_reached = all(
                abs(current[axis] - target) < self._target_tolerances_um.get(axis, 1.0)
                for axis, target in self._last_targets_um.items()
                if axis in target_axes
            )
            if all_stable and all_reached:
                return
            if all_stable and not all_reached:
                corrected = self._try_correct_stable_target_error(current, corrections)
                if corrected:
                    previous = {
                        axis: self.get_axis_position_um(axis, preserve_enabled_channels=True)
                        for axis in target_axes
                    }
                    continue

            previous = current
            elapsed_ms = (time.monotonic() - t_start) * 1000.0
            if elapsed_ms > timeout_ms:
                current_text = ", ".join(f"{axis}={value:.3f}" for axis, value in current.items())
                target_text = ", ".join(f"{axis}={value:.3f}" for axis, value in self._last_targets_um.items())
                delta_text = ", ".join(
                    f"{axis}={current[axis] - target:.3f}"
                    for axis, target in self._last_targets_um.items()
                )
                tolerance_text = ", ".join(
                    f"{axis}={self._target_tolerances_um.get(axis, 1.0):.3f}"
                    for axis in self._last_targets_um
                )
                raise StageTimeoutError(
                    f"Stage did not settle within {timeout_ms} ms "
                    f"(current {current_text}; target {target_text}; "
                    f"delta {delta_text}; tolerance {tolerance_text})"
                )

    def stop(self) -> None:
        try:
            self._send("[stop]")
        except Exception:
            pass

    def _normalize_wait_axes(self, axes: set[str] | None) -> set[str]:
        if axes is None:
            return set(self._last_targets_um)
        normalized = {axis.lower() for axis in axes}
        unknown = normalized.difference(self._channels)
        if unknown:
            raise ValueError(f"Unsupported wait axes: {sorted(unknown)}")
        return normalized.intersection(self._last_targets_um)

    def _try_correct_stable_target_error(
        self,
        current: dict[str, float],
        corrections: dict[str, int],
    ) -> bool:
        corrected = False
        for axis, current_um in current.items():
            target_um = self._last_targets_um[axis]
            error_um = target_um - current_um
            reached = abs(error_um) < self._target_tolerances_um.get(axis, 1.0)
            close_enough_to_retry = abs(error_um) <= self._settle_correction_threshold_um
            can_retry = corrections[axis] < self._settle_correction_attempts
            if reached or not close_enough_to_retry or not can_retry:
                continue
            corrections[axis] += 1
            self._move_axis_absolute_um(axis, target_um)
            corrected = True
        return corrected

    def move_axis_pulses(self, axis: str, pulses: int) -> None:
        if pulses == 0:
            return
        abs_pulses = abs(int(pulses))
        if abs_pulses > 999999:
            raise ValueError("pulse count must be <= 999999")
        self._select_axis(axis)
        sign = "+" if pulses > 0 else "-"
        self._send(f"[{sign}:{abs_pulses:06d}]", wait_ms=self._move_cmd_wait_ms)
        self._last_pulse_axes.add(axis.lower())

    def move_relative_pulses(
        self,
        *,
        x_pulses: int = 0,
        y_pulses: int = 0,
        z_pulses: int = 0,
    ) -> None:
        for axis, pulses in {"x": x_pulses, "y": y_pulses, "z": z_pulses}.items():
            self.move_axis_pulses(axis, pulses)

    def read_remaining_pulses(self, axis: str) -> int:
        self._select_axis(axis)
        response = self._send("[read:pulse?]")
        text = response.strip().replace("[", "").replace("]", "")
        try:
            return int(text)
        except ValueError as exc:
            raise StageCommandError(
                f"Cannot parse {axis.upper()} remaining pulse response: '{response}'"
            ) from exc

    def wait_pulses_complete(self, timeout_ms: int) -> None:
        if not self._last_pulse_axes:
            return
        t_start = time.monotonic()
        while True:
            remaining = {
                axis: self.read_remaining_pulses(axis)
                for axis in sorted(self._last_pulse_axes)
            }
            if all(value <= 0 for value in remaining.values()):
                return
            elapsed_ms = (time.monotonic() - t_start) * 1000.0
            if elapsed_ms > timeout_ms:
                remaining_text = ", ".join(f"{axis}={value}" for axis, value in remaining.items())
                raise StageTimeoutError(
                    f"Stage pulses did not complete within {timeout_ms} ms "
                    f"(remaining {remaining_text})"
                )
            time.sleep(0.050)

    def _move_axis_absolute_um(self, axis: str, target_um: float) -> None:
        current_um = self.get_axis_position_um(axis, preserve_enabled_channels=True)
        distance_um = target_um - current_um
        step_um = self._segmented_move_step_um
        if (
            self._segmented_move_threshold_um > 0
            and step_um > 0
            and abs(distance_um) > self._segmented_move_threshold_um
        ):
            direction = 1.0 if distance_um > 0 else -1.0
            next_target_um = current_um
            while abs(target_um - next_target_um) > step_um:
                next_target_um += direction * step_um
                self._send_axis_movetarget(axis, next_target_um)
                time.sleep(0.050)
        self._send_axis_movetarget(axis, target_um)
        self._last_targets_um[axis] = target_um

    def _send_axis_movetarget(self, axis: str, target_um: float) -> None:
        self._apply_axis_motion_profile(axis)
        self._select_axis(axis)
        target_mm = target_um / 1000.0
        self._send(f"[movetarget:{target_mm:.6f}]", wait_ms=self._move_cmd_wait_ms)

    def _apply_axis_motion_profile(self, axis: str) -> None:
        key = axis.lower()
        if key not in self._axis_motion_profiles:
            raise ValueError(f"Unsupported axis: {axis}")
        profile = self._axis_motion_profiles[key]
        if self._active_motion_profile == profile:
            return
        units, mode, voltage_v, frequency_hz = profile
        self.configure_motion(
            units=units,
            mode=mode,
            voltage_v=voltage_v,
            frequency_hz=frequency_hz,
        )
        self._active_motion_profile = profile

    def _select_axis(self, axis: str, *, disable_others: bool | None = None) -> None:
        key = axis.lower()
        if key not in self._channels:
            raise ValueError(f"Unsupported axis: {axis}")
        channel = self._channels[key]
        if disable_others is None:
            disable_others = self._exclusive_channel
        if disable_others:
            for enabled in sorted(self._enabled_channels):
                if enabled != channel:
                    self._send(f"[ch{enabled}:0]")
                    self._enabled_channels.discard(enabled)
        self._send(f"[ch{channel}:1]")
        self._enabled_channels.add(channel)
        time.sleep(self._channel_switch_wait_ms / 1000.0)

    def _send(self, cmd: str, wait_ms: float | None = None) -> str:
        if self._ser is None:
            raise StageConnectionError("Serial port is not connected.")
        if wait_ms is None:
            wait_ms = self._default_cmd_wait_ms
        try:
            self._ser.reset_input_buffer()
        except Exception:
            pass
        self._ser.write(cmd.encode("ascii"))
        time.sleep(wait_ms / 1000.0)
        chunks = []
        deadline = time.monotonic() + self._response_collect_ms / 1000.0
        while True:
            chunk = self._ser.read_all()
            if chunk:
                chunks.append(chunk)
                if b"]" in b"".join(chunks):
                    break
            elif not chunks:
                break
            if time.monotonic() >= deadline:
                break
            time.sleep(0.005)
        return b"".join(chunks).decode("ascii", errors="replace").strip()

    @staticmethod
    def _parse_position_um(response: str) -> float:
        matches = re.findall(r"\[pos:([+-]?\d+(?:\.\d+)?)\]", response or "")
        if not matches:
            raise ValueError(response)
        return float(matches[-1]) * 1000.0
