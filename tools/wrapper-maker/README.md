# Wrapper Maker

`wrapper-maker` is a local helper to promote repeated ad-hoc ExtendScript workflows into wrapper candidates.

It is intentionally lightweight:

- logs ad-hoc usage events (`record`)
- scores frequent + reliable patterns (`candidates`)
- generates implementation scaffold (`scaffold`)

Runtime auto-hook:

- `run-script` calls are auto-recorded into `.local/wrapper-maker/adhoc-usage.jsonl`
- no manual `record` step is required for those calls

## Quick Start

Record ad-hoc usage:

```bash
npm run wrapper:maker -- record --name bounce-drop --intent "Ball drop with bounce" --status success
```

Build candidate report:

```bash
npm run wrapper:maker -- candidates --lookback-days 14 --min-uses 5 --min-success-rate 0.8
```

Generate scaffold:

```bash
npm run wrapper:maker -- scaffold --from-candidate bounce-drop
```

## Local Storage

Default local workspace:

- `.local/wrapper-maker/`

Generated artifacts:

- `.local/wrapper-maker/adhoc-usage.jsonl`
- `.local/wrapper-maker/reports/candidates-latest.json`
- `.local/wrapper-maker/scaffolds/*`

These are local-only and should not be committed.
