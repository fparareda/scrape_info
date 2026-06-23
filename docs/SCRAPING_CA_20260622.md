# CA Scraper Scouting — 2026-06-22

## Selected source: CRNS SK (crns-sk-nurses)

| Field | Value |
|---|---|
| Authority | College of Registered Nurses of Saskatchewan |
| URL | https://crns.alinityapp.com/Client/PublicDirectory |
| Category | enfermeria |
| Est. records | ~15,000 RNs + NPs |
| Platform | Alinity (same as 15+ other CA regulators in repo) |
| Env flag | `PROLIO_RUN_CRNS_SK_NURSES=true` |
| Budget knob | `PROLIO_CRNS_SK_NURSES_LIMIT` (default 20,000) |

### Pre-flight checks

- **robots.txt**: returns 404 — no restrictions
- **Auth**: none required
- **CAPTCHA**: not observed
- **API**: POST `/Registrants` Alinity endpoint — identical to CLPNS, CAP-psychologists, CPSA, etc.
- **Overlap**: existing open PR `clpns-sk-nurses` covers Licensed Practical Nurses (different licence class) — no duplication

### Rejected candidates

| Candidate | Reason |
|---|---|
| CNPBC (BC NPs) | Already covered by existing BC sources; NPs covered under other scraper |
| NANB New Brunswick nurses | Alinity but province already has multiple scrapers; lower priority vs SK gap |
| RPAM (Quebec architects) | Requires French parsing, different API pattern; deferred |
| OALO Ontario optometrists | JS-rendered SPA, no public API detected |

### Workflow files (apply manually — GitHub App lacks `workflows` permission)

**`.github/workflows/scrape-crns-sk-nurses.yml`** (new file):
```yaml
name: Scrape · CRNS SK nurses (CA enfermeria)
on:
  schedule:
    - cron: "0 6 10 * *"
  workflow_dispatch:
jobs:
  run:
    uses: ./.github/workflows/_scrape-runner.yml
    secrets: inherit
    with:
      source: crns-sk-nurses
      timeout_minutes: 60
```

**`.github/workflows/_scrape-runner.yml`** — add after `PROLIO_RUN_WA_DOH_PSYCHOLOGISTS` line:
```yaml
          PROLIO_RUN_CRNS_SK_NURSES: ${{ inputs.source == 'crns-sk-nurses' && 'true' || 'false' }}
          PROLIO_CRNS_SK_NURSES_LIMIT: ${{ inputs.limit }}
```
