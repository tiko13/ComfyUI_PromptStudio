"""Stop a Prompt Studio-owned llama.cpp server after its ComfyUI owner exits."""

import argparse
import hmac
import json
import os
import signal
import time


MAX_STATE_BYTES = 16 * 1024
POLL_SECONDS = 1
TERMINATE_TIMEOUT_SECONDS = 10


def _normalized_process_path(path):
    return os.path.normcase(os.path.realpath(os.path.abspath(str(path or "").strip())))


def _windows_process_snapshot(pid, *, terminate=False, expected=None):
    import ctypes
    from ctypes import wintypes

    query = 0x1000
    synchronize = 0x00100000
    terminate_access = 0x0001 if terminate else 0
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.GetProcessTimes.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
    ]
    handle = kernel32.OpenProcess(query | synchronize | terminate_access, False, int(pid))
    if not handle:
        return None
    try:
        if kernel32.WaitForSingleObject(handle, 0) != 0x00000102:
            return None
        buffer = ctypes.create_unicode_buffer(32768)
        size = wintypes.DWORD(len(buffer))
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return None
        created = wintypes.FILETIME()
        exited = wintypes.FILETIME()
        kernel = wintypes.FILETIME()
        user = wintypes.FILETIME()
        if not kernel32.GetProcessTimes(
            handle,
            ctypes.byref(created),
            ctypes.byref(exited),
            ctypes.byref(kernel),
            ctypes.byref(user),
        ):
            return None
        marker = (int(created.dwHighDateTime) << 32) | int(created.dwLowDateTime)
        snapshot = {
            "executable": _normalized_process_path(buffer.value),
            "creation_marker": f"windows:{marker}",
        }
        if terminate:
            if not _process_snapshots_match(snapshot, expected):
                return None
            kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
            if not kernel32.TerminateProcess(handle, 1):
                raise OSError(ctypes.get_last_error(), "Could not terminate Llama.cpp")
        return snapshot
    finally:
        kernel32.CloseHandle(handle)


def _process_snapshot(pid):
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    if pid <= 0:
        return None
    if os.name == "nt":
        try:
            return _windows_process_snapshot(pid)
        except (OSError, ValueError):
            return None
    try:
        executable = os.readlink(f"/proc/{pid}/exe")
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as handle:
            fields = handle.read().rsplit(") ", 1)[1].split()
        start_ticks = fields[19]
    except (OSError, IndexError, ValueError):
        return None
    return {
        "executable": _normalized_process_path(executable),
        "creation_marker": f"proc:{start_ticks}",
    }


def _process_snapshots_match(actual, expected):
    if not isinstance(actual, dict) or not isinstance(expected, dict):
        return False
    actual_executable = str(actual.get("executable") or "").strip()
    expected_executable = str(expected.get("executable") or "").strip()
    actual_marker = str(actual.get("creation_marker") or "").strip()
    expected_marker = str(expected.get("creation_marker") or "").strip()
    return bool(
        actual_executable
        and expected_executable
        and actual_marker
        and expected_marker
        and _normalized_process_path(actual_executable)
        == _normalized_process_path(expected_executable)
        and hmac.compare_digest(actual_marker, expected_marker)
    )


def _read_owned_state(state_path, token):
    try:
        if os.path.getsize(state_path) > MAX_STATE_BYTES:
            return None
        with open(state_path, "r", encoding="utf-8") as handle:
            state = json.load(handle)
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(state, dict):
        return None
    watchdog = state.get("watchdog")
    recorded_token = str(watchdog.get("token") or "") if isinstance(watchdog, dict) else ""
    if state.get("version") != 2 or not hmac.compare_digest(recorded_token, token):
        return None
    return state


def _terminate_process(pid, identity):
    if os.name == "nt":
        _windows_process_snapshot(pid, terminate=True, expected=identity)
        return
    if not _process_snapshots_match(_process_snapshot(pid), identity):
        return
    os.kill(int(pid), signal.SIGTERM)
    deadline = time.monotonic() + TERMINATE_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if not _process_snapshots_match(_process_snapshot(pid), identity):
            return
        time.sleep(0.1)
    if _process_snapshots_match(_process_snapshot(pid), identity):
        os.kill(int(pid), signal.SIGKILL)


def run_watchdog(state_path, token):
    state = _read_owned_state(state_path, token)
    if state is None:
        return
    watchdog = state["watchdog"]
    owner_pid = watchdog.get("owner_pid")
    owner_identity = watchdog.get("owner_identity")
    target_pid = state.get("pid")
    target_identity = state.get("identity")

    while _process_snapshots_match(_process_snapshot(owner_pid), owner_identity):
        if _read_owned_state(state_path, token) is None:
            return
        if not _process_snapshots_match(_process_snapshot(target_pid), target_identity):
            return
        time.sleep(POLL_SECONDS)

    try:
        grace_seconds = max(0, min(86400, int(watchdog.get("grace_seconds", 120))))
    except (TypeError, ValueError):
        grace_seconds = 120
    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        if _read_owned_state(state_path, token) is None:
            return
        if not _process_snapshots_match(_process_snapshot(target_pid), target_identity):
            return
        time.sleep(min(POLL_SECONDS, max(0, deadline - time.monotonic())))

    if _read_owned_state(state_path, token) is None:
        return
    _terminate_process(target_pid, target_identity)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-path", required=True)
    parser.add_argument("--token", required=True)
    arguments = parser.parse_args()
    run_watchdog(os.path.abspath(arguments.state_path), arguments.token)


if __name__ == "__main__":
    main()
