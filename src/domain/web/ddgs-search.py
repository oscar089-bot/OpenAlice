"""Backend-fallback web search via the Python `ddgs` package.

Mirrors Vibe-Trading's `web_search` behavior: DuckDuckGo's own endpoint is
frequently rate-limited, but `ddgs` can query several backends. We try them in
order and return the first that yields results.

Invoked as:  python3 ddgs_search.py <query> <max_results> <timelimit|->
Emits one JSON object on stdout.
"""

import json
import sys


def main() -> None:
    query = sys.argv[1]
    max_results = int(sys.argv[2])
    timelimit = sys.argv[3]

    try:
        from ddgs import DDGS
    except ImportError:
        print(json.dumps({"status": "unavailable", "error": "python ddgs not installed"}))
        return

    # Order matters: backends that reliably answer from datacenter IPs first.
    backends = ["brave", "bing", "google", "yahoo", "mullvad", "duckduckgo", "mojeek"]
    opts = {"max_results": max_results}
    if timelimit and timelimit != "-":
        opts["timelimit"] = timelimit

    errors: list[str] = []
    for backend in backends:
        try:
            with DDGS(timeout=10) as ddgs:
                raw = list(ddgs.text(query, backend=backend, **opts))
        except Exception as exc:  # noqa: BLE001 - report, never crash the tool
            errors.append(f"{backend}: {str(exc)[:80]}")
            continue
        if not raw:
            errors.append(f"{backend}: no results")
            continue
        results = [
            {
                "title": r.get("title", ""),
                "url": r.get("href", ""),
                "snippet": r.get("body", ""),
            }
            for r in raw
        ][:max_results]
        print(json.dumps({"status": "ok", "backend": backend, "results": results}, ensure_ascii=False))
        return

    print(json.dumps({"status": "error", "error": "; ".join(errors) or "no backend returned results"}))


if __name__ == "__main__":
    main()
