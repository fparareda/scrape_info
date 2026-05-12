# Local scraper scheduling (launchd)

COPC (and any other colegio whose backend blocks datacenter IPs) runs on
the founder's Mac via `launchd`. GitHub Actions handles Google Places and
BORME where residential IPs aren't required.

## Install

1. Copy the plist to the per-user LaunchAgents folder:
   ```sh
   cp apps/scraper/launchd/co.prolio.scraper-colegios.plist \
      ~/Library/LaunchAgents/
   ```
2. Open the copy and edit `WORKING_DIR` to the absolute path of your
   `prolio` checkout on this Mac.
3. Load it:
   ```sh
   launchctl load ~/Library/LaunchAgents/co.prolio.scraper-colegios.plist
   ```
4. Test it fires manually:
   ```sh
   launchctl start co.prolio.scraper-colegios
   tail -f /tmp/prolio-scraper-colegios.out.log
   ```

## Schedule

Mondays at 05:15 local time. If the Mac is asleep the job runs at next
wake (default launchd behaviour for `StartCalendarInterval`). No run at
boot (`RunAtLoad=false`) so a laptop restart doesn't trigger unexpected
scraping.

## Troubleshooting

- **Nothing happens**: `launchctl list | grep prolio` should show the
  label. If missing, the `load` failed — check `log show --predicate
  'subsystem == "com.apple.xpc.launchd"' --last 10m`.
- **Exit code 127 / `pnpm not found`**: the plist invokes pnpm via full
  path. Adjust `/Users/ferran.parareda/Library/pnpm/pnpm` to your
  installation (`which pnpm`).
- **Can't read .env.local**: the scraper's loader reads
  `apps/scraper/.env.local` relative to its cwd. The plist `cd`s into
  `WORKING_DIR`; verify the path points at the repo root, not
  `apps/scraper`.

## Unload

```sh
launchctl unload ~/Library/LaunchAgents/co.prolio.scraper-colegios.plist
rm ~/Library/LaunchAgents/co.prolio.scraper-colegios.plist
```
