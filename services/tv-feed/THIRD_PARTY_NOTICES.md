# Third-party code

## tradingview_vendor/

The `tradingview_vendor/` directory contains an unmodified copy of a third-party
JavaScript TradingView WebSocket client (CommonJS). It is vendored because it is
not published on npm in a form suitable for direct dependency use.

- **Origin**: third-party, not authored in this repository.
- **Version**: unpinned — the upstream source did not carry a version string when
  it was copied in. Treat upgrades as manual, reviewed replacements.
- **License**: NOT recorded in the vendored copy. Verify the upstream project's
  license before redistributing this repository or shipping it as a product.

If you re-vendor this code, record the upstream repository URL, commit hash, and
license here so the provenance is auditable.
