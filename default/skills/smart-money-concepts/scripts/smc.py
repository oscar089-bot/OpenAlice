#!/usr/bin/env python3
"""Smart Money Concepts bridge for OpenAlice.

Reads K-lines through the `alice` CLI, runs the upstream `smartmoneyconcepts`
package (MIT, https://github.com/joshyattridge/smart-money-concepts), and
prints JSON. Analysis only: this never talks to a broker or places an order.

    python3 smc.py analyze --bar-id 'yfinance|AAPL' --interval 1d --count 250
    python3 smc.py list

Exit codes: 0 ok, 2 bad usage, 3 missing dependency, 4 data fetch failed.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

PROG = "smc"

# Detector name -> (function attribute, indicator flags it needs as input).
# Order matters: the dependency chain resolves in this sequence.
INDICATORS = {
    "swing_highs_lows": ("swing_highs_lows", []),
    "fvg": ("fvg", []),
    "bos_choch": ("bos_choch", ["swing_highs_lows"]),
    "ob": ("ob", ["swing_highs_lows"]),
    "liquidity": ("liquidity", ["swing_highs_lows"]),
    "retracements": ("retracements", ["swing_highs_lows"]),
    "previous_high_low": ("previous_high_low", []),
    "sessions": ("sessions", []),
}
DEFAULT_INDICATORS = list(INDICATORS)

# Some detectors describe a *state* that holds on every bar rather than a
# discrete event. Dumping 300 identical-looking rows is noise, so they collapse:
#   latest -> only the most recent reading ("where are we now")
#   active -> only bars where the session is actually on
# Everything else reports discrete events and keeps its full history.
INDICATOR_MODE = {
    "previous_high_low": "latest",
    "retracements": "latest",
    "sessions": "active",
}
DEFAULT_MODE = "events"


def die(msg: str, code: int) -> None:
    print(f"{PROG}: {msg}", file=sys.stderr)
    raise SystemExit(code)


# ==================== Dependency bootstrap ====================
#
# This Skill owns its own environment instead of borrowing whatever interpreter
# happens to be first on PATH. Resolution order:
#
#   1. An interpreter that ALREADY has the deps is used as-is, so a user (or an
#      AutoQuant desk) who installed them deliberately keeps control.
#   2. Otherwise a dedicated venv is created under the user-state root and this
#      script re-executes itself inside it.
#
# The venv deliberately lives OUTSIDE the Skill tree. Alice fingerprints every
# file in a Skill to compute the injection revision, and copies that tree into
# each Workspace, so a venv in there would corrupt the version fingerprint and
# be duplicated per Workspace.

PACKAGE = "smartmoneyconcepts"
PINNED = ["pandas", "smartmoneyconcepts"]


def note(msg: str) -> None:
    """Progress goes to stderr so stdout stays pure JSON."""
    print(f"{PROG}: {msg}", file=sys.stderr)


def venv_dir() -> str:
    override = os.environ.get("OPENALICE_SMC_VENV")
    if override:
        return override
    root = os.environ.get("OPENALICE_HOME") or os.path.join(
        os.path.expanduser("~"), ".openalice"
    )
    return os.path.join(root, "tools", "smc-venv")


def venv_python(directory: str) -> str:
    if os.name == "nt":
        return os.path.join(directory, "Scripts", "python.exe")
    return os.path.join(directory, "bin", "python")


def install_hint() -> str:
    return (
        "missing Python dependency. The Skill can build its own environment, but\n"
        "bootstrap was disabled or failed. Either drop --no-bootstrap, or install\n"
        f"manually:\n  python3 -m pip install {' '.join(PINNED)}"
    )


def run(cmd: list[str], label: str) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        die(f"{label} failed:\n{proc.stderr.strip() or proc.stdout.strip()}", 3)


def deps_importable() -> bool:
    os.environ.setdefault("SMC_CREDIT", "0")
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import pandas  # noqa: F401
            import smartmoneyconcepts  # noqa: F401
        return True
    except ImportError:
        return False


def venv_has_deps(python: str) -> bool:
    probe = subprocess.run(
        [python, "-c", f"import pandas, {PACKAGE}"],
        capture_output=True,
        text=True,
        env=dict(os.environ, SMC_CREDIT="0"),
    )
    return probe.returncode == 0


def build_venv(directory: str) -> None:
    """Create the venv with uv when available, else stdlib venv + pip."""
    os.makedirs(os.path.dirname(directory), exist_ok=True)
    uv = shutil.which("uv")
    if uv:
        note(f"creating environment with uv at {directory}")
        run([uv, "venv", "--quiet", directory], "uv venv")
        run(
            [uv, "pip", "install", "--quiet", "--python", venv_python(directory), *PINNED],
            "uv pip install",
        )
        return
    note(f"uv not found; creating environment with venv at {directory}")
    run([sys.executable, "-m", "venv", directory], "python -m venv")
    run(
        [venv_python(directory), "-m", "pip", "install", "--quiet", "--upgrade", "pip"],
        "pip upgrade",
    )
    run(
        [venv_python(directory), "-m", "pip", "install", "--quiet", *PINNED],
        "pip install",
    )


def ensure_env(allow_bootstrap: bool) -> None:
    """Guarantee the deps are importable in THIS process, else re-exec."""
    if os.environ.get("OPENALICE_SMC_BOOTSTRAPPED"):
        # We already re-executed once and still lack the deps: do not loop.
        die(install_hint(), 3)

    directory = venv_dir()
    python = venv_python(directory)
    if not (os.path.exists(python) and venv_has_deps(python)):
        if not allow_bootstrap:
            die(install_hint(), 3)
        build_venv(directory)

    if os.path.realpath(sys.executable) != os.path.realpath(python):
        note(f"switching to Skill environment at {directory}")
        env = dict(os.environ, OPENALICE_SMC_BOOTSTRAPPED="1")
        os.execve(python, [python, os.path.abspath(__file__), *sys.argv[1:]], env)


def load_deps(allow_bootstrap: bool = True):
    # The package prints a credit banner to STDOUT on first import, which would
    # corrupt our JSON. SMC_CREDIT=0 suppresses it; redirecting stdout during
    # import is the safety net for any other stray print the package adds.
    os.environ.setdefault("SMC_CREDIT", "0")
    if not deps_importable():
        ensure_env(allow_bootstrap)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import pandas as pd
            from smartmoneyconcepts import smc
    except ImportError as exc:
        die(f"missing Python dependency ({exc.name}).\n{install_hint()}", 3)
    return pd, smc


def fetch_bars(args) -> dict:
    """Run `alice market bars` and return the parsed {bars, meta} payload."""
    alice = shutil.which("alice")
    if not alice:
        die("`alice` is not on PATH; run this from an OpenAlice Workspace shell", 4)

    cmd = [
        alice, "market", "bars",
        "--bar-id", args.bar_id,
        "--interval", args.interval,
        "--count", str(args.count),
    ]
    if args.asset_class:
        cmd += ["--asset-class", args.asset_class]

    fd, path = tempfile.mkstemp(prefix="smc-bars-", suffix=".json")
    os.close(fd)
    try:
        cmd += ["--output", path]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            die(f"alice market bars failed: {proc.stderr.strip() or proc.stdout.strip()}", 4)
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    if not isinstance(payload, dict) or not payload.get("bars"):
        die(f"no bars returned for barId '{args.bar_id}' at interval '{args.interval}'", 4)
    return payload


def prepare_frame(pd, payload: dict):
    """Build the lowercase ohlc(+volume) frame the package expects."""
    frame = pd.DataFrame(payload["bars"])
    required = ["open", "high", "low", "close"]
    missing = [name for name in required if name not in frame.columns]
    if missing:
        die(f"bar payload missing columns: {', '.join(missing)}", 4)

    if "date" in frame.columns:
        frame.index = pd.to_datetime(frame["date"], errors="coerce")
        frame = frame.drop(columns=["date"])
    frame = frame[[c for c in ("open", "high", "low", "close", "volume") if c in frame.columns]]
    for column in frame.columns:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    return frame.dropna(subset=required)


def clean(value):
    """Make a cell JSON-safe: NaN/inf -> None, numpy scalars -> Python."""
    if value is None:
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if hasattr(value, "item"):
        try:
            value = value.item()
        except (ValueError, AttributeError):
            pass
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def rows_from_frame(frame, dates, columns, mode):
    """Emit detector rows, each carrying its bar date.

    mode='events' keeps every non-empty row (discrete detectors).
    mode='latest' keeps only the most recent reading.
    mode='active' keeps only rows where the session is on.
    mode='all'    keeps everything, including all-null rows.
    """
    out = []
    for position, (_, row) in enumerate(frame.iterrows()):
        record = {"date": dates[position]}
        for column in columns:
            if column in frame.columns:
                record[column] = clean(row[column])
        # Drop rows where every detector column is null (no event on this bar).
        if mode != "all" and all(record.get(column) is None for column in columns):
            continue
        out.append(record)

    if mode == "active":
        return [row for row in out if row.get("Active") == 1]
    if mode == "latest":
        return out[-1:]
    return out


def run_analyze(args) -> dict:
    pd, smc = load_deps(allow_bootstrap=not args.no_bootstrap)
    payload = fetch_bars(args)
    frame = prepare_frame(pd, payload)
    dates = [clean(value) for value in frame.index]

    requested = args.indicators.split(",") if args.indicators else DEFAULT_INDICATORS
    requested = [name.strip() for name in requested if name.strip()]
    unknown = [name for name in requested if name not in INDICATORS]
    if unknown:
        die(f"unknown indicator(s): {', '.join(unknown)}. Use `list` to see valid names", 2)

    # Resolve the dependency chain (e.g. bos_choch needs swing_highs_lows).
    needed: list[str] = []
    for name in requested:
        for dep in INDICATORS[name][1]:
            if dep not in needed:
                needed.append(dep)
        if name not in needed:
            needed.append(name)

    computed: dict[str, object] = {}
    for name in needed:
        func_name = INDICATORS[name][0]
        func = getattr(smc, func_name, None)
        if func is None:
            die(f"installed smartmoneyconcepts has no '{func_name}' (upgrade the package)", 3)
        try:
            # Detectors must not be allowed to pollute our stdout either.
            with contextlib.redirect_stdout(sys.stderr):
                computed[name] = func(frame, **build_kwargs(name, args, computed))
        except TypeError as exc:
            die(f"{func_name} rejected these parameters: {exc}", 2)

    result = {}
    for name in requested:
        table = computed[name]
        if table is None:
            result[name] = None
            continue
        mode = "all" if args.full_series else INDICATOR_MODE.get(name, DEFAULT_MODE)
        result[name] = rows_from_frame(table, dates, list(table.columns), mode)

    meta = payload.get("meta") or {}
    return {
        "barId": args.bar_id,
        "interval": args.interval,
        "bars": int(len(frame)),
        "from": dates[0] if dates else None,
        "to": dates[-1] if dates else None,
        "swingLength": args.swing_length,
        "source": meta,
        "indicators": result,
    }


def build_kwargs(name: str, args, computed: dict) -> dict:
    """Map CLI flags onto each detector's upstream signature."""
    if name == "swing_highs_lows":
        return {"swing_length": args.swing_length}
    if name == "bos_choch":
        return {"swing_highs_lows": computed["swing_highs_lows"], "close_break": args.close_break}
    if name == "ob":
        return {"swing_highs_lows": computed["swing_highs_lows"], "close_mitigation": args.close_mitigation}
    if name == "liquidity":
        return {"swing_highs_lows": computed["swing_highs_lows"], "range_percent": args.range_percent}
    if name == "retracements":
        return {"swing_highs_lows": computed["swing_highs_lows"]}
    if name == "fvg":
        return {"join_consecutive": args.join_consecutive}
    if name == "previous_high_low":
        return {"time_frame": args.time_frame}
    if name == "sessions":
        kwargs = {"session": args.session, "time_zone": args.time_zone}
        if args.session == "Custom":
            kwargs["start_time"] = args.start_time
            kwargs["end_time"] = args.end_time
        return kwargs
    return {}


def run_bars(args) -> dict:
    pd, _ = load_deps(allow_bootstrap=not args.no_bootstrap)
    payload = fetch_bars(args)
    frame = prepare_frame(pd, payload)
    return {
        "barId": args.bar_id,
        "interval": args.interval,
        "meta": payload.get("meta") or {},
        "bars": json.loads(frame.reset_index().to_json(orient="records", date_format="iso")),
    }


def run_list(_args) -> dict:
    return {
        "defaults": {
            "swing_length": 50,
            "range_percent": 0.01,
            "close_break": True,
            "close_mitigation": False,
            "join_consecutive": False,
            "time_frame": "1D",
            "time_zone": "UTC",
        },
        "indicators": [
            {"name": name, "requires": INDICATORS[name][1], "upstream": INDICATORS[name][0]}
            for name in INDICATORS
        ],
        "package": "smartmoneyconcepts (MIT) — https://github.com/joshyattridge/smart-money-concepts",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=PROG, description="Smart Money Concepts analysis over OpenAlice K-lines.")
    sub = parser.add_subparsers(dest="verb", required=True)

    def add_data_flags(target):
        target.add_argument("--bar-id", required=True, help="e.g. 'yfinance|AAPL' from `alice market search-bars`")
        target.add_argument("--interval", default="1d", help="1m 5m 15m 30m 1h 4h 1d 1w (default: 1d)")
        target.add_argument("--count", type=int, default=250, help="most-recent N bars (default: 250)")
        target.add_argument("--asset-class", choices=["equity", "crypto", "currency", "commodity"], help="explicit hint for ambiguous vendor barIds")
        target.add_argument("--no-bootstrap", action="store_true", help="never create a Skill venv; fail if the deps are missing from the current interpreter")

    analyze = sub.add_parser("analyze", help="run the requested indicators")
    add_data_flags(analyze)
    analyze.add_argument("--indicators", help=f"comma-separated subset of: {', '.join(INDICATORS)}")
    analyze.add_argument("--full-series", action="store_true", help="dump every bar for state detectors instead of the latest/session-active summary")
    analyze.add_argument("--swing-length", type=int, default=50)
    analyze.add_argument("--range-percent", type=float, default=0.01)
    analyze.add_argument("--close-break", action=argparse.BooleanOptionalAction, default=True)
    analyze.add_argument("--close-mitigation", action=argparse.BooleanOptionalAction, default=False)
    analyze.add_argument("--join-consecutive", action=argparse.BooleanOptionalAction, default=False)
    analyze.add_argument("--time-frame", default="1D", help="15m 1H 4H 1D 1W 1M (previous_high_low)")
    analyze.add_argument("--session", default="London", help="Sydney Tokyo London 'New York' 'Asian kill zone' 'London open kill zone' 'New York kill zone' 'london close kill zone' Custom")
    analyze.add_argument("--start-time", help="HH:MM, Custom session only")
    analyze.add_argument("--end-time", help="HH:MM, Custom session only")
    analyze.add_argument("--time-zone", default="UTC", help="e.g. UTC+0, GMT+0 (default: UTC)")

    bars = sub.add_parser("bars", help="emit the prepared OHLCV frame")
    add_data_flags(bars)

    sub.add_parser("list", help="list indicators, parameters and defaults")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.verb == "analyze":
        result = run_analyze(args)
    elif args.verb == "bars":
        result = run_bars(args)
    else:
        result = run_list(args)
    json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
