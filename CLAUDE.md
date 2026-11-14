# Game Stats

## Always commit and push

Commit and push every change to `main` as soon as it's made and the tests pass (`cd collector && npm test`).
Don't wait to be asked and don't leave anything uncommitted. This is our own internal dashboard: it's checked
from other computers, never on the Mac that runs it, and a broken build is fine (fix it in the next push).

- The Mac pulls `main` every 10 minutes (deploy/update-mac.sh), runs the tests and restarts the collector. It
  skips updates while the Mac's checkout has uncommitted changes to tracked files, so anything left
  uncommitted there blocks every later update.
- To have a change live at once instead of within 10 minutes: on the Mac, `git pull --ff-only` in
  ~/Developer/Game-Stats-Dashboard, then `kill -TERM "$(cat collector/data/collector.pid)"` (launchd starts it
  again).
