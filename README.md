# Lifting Tracker

Phone + TV workout tracker that runs [OpenLifting](https://github.com/clintberry/openlifting-spec) programs.

```sh
npm install
npm start          # PORT=3000 by default
```

- **Phone:** open the LAN URL the server prints (e.g. `http://192.168.1.20:3000/`). Add to Home Screen for an app feel.
- **TV:** open the same address with `/tv` in the TV's browser. It follows the phone live: current set, weight, plates per side (planned for the fewest plate changes), rest timer, up next.

## Files

| path | what |
|------|------|
| `programs/*.yaml` | OpenLifting programs. Edit and refresh; with more than one, pick in Settings. |
| `data/logs/*.yaml` | One OpenLifting log per finished workout. Weight suggestions come from these. |
| `data/state.json` | App state: settings (your plates), the workout in progress, the rest timer. |

Set `DATA_DIR` / `PROGRAMS_DIR` to move them. Back up `data/`.

Logs carry two app extensions on entries: `x-progress: none` (a light day, don't progress from it) and `x-fallback: true` (the fallback sets were used).

## Deploy

Pushing to `main` deploys to the exe.dev VM (`https://lifting.exe.xyz/`) via `.github/workflows/deploy.yml`: it rsyncs the app (never `data/`), runs `npm ci`, and restarts the `lifting` systemd service. Secrets: `EXE_SSH_KEY` (an SSH key scoped to the `lifting` VM) and `EXE_KNOWN_HOSTS`. Re-run a deploy from the Actions tab with "Run workflow".
