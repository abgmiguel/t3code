# Local Mac dictation fork

The Mac composer records up to five minutes and inserts a Phonon-2 transcript at
the captured selection for review. Stop transcribes; Cancel discards the audio.
Sending and editing are blocked during capture and transcription. Changing
threads cancels the operation. Speech is processed on this Mac even when the
selected T3 environment is remote. This is independent of the coding provider.

This uses Baby Scribe's pinned Phonon-2 Core ML model, not a verified copy of the
Codex desktop app's private dictation implementation. No recording is uploaded.
One native speech process is warmed when the Mac composer opens and keeps the
model loaded between recordings. Initial preparation can take minutes on an
M1 Mac; it does not repeat for each recording while the worker stays running.
Quitting T3 stops the worker. Cancelling active inference also stops it, and the
next recording prepares a new worker. Only one local transcription runs at once
across desktop windows.

The native process receives a temporary WAV that is removed after success,
failure, or cancellation. The model and executable live outside the T3 app at
`~/Library/Application Support/T3Dictation`, so replacing T3 does not remove them.
The model retains Fermion and NVIDIA attribution and its CC-BY-4.0 license.

Install the native runtime on an Apple Silicon Mac with macOS 15 or later and
Xcode command line tools:

```sh
node scripts/setup-local-dictation.mjs
```

To reuse Baby Scribe's identical verified model files without downloading them,
pass its checkout path. Copies use APFS cloning where available. Runtime and
model revisions are pinned in the setup script; every model asset is checked
against the published SHA-256 manifest. First model preparation can take minutes.

Run `node scripts/check-local-dictation.mjs` to generate a synthetic spoken
phrase with macOS speech synthesis and transcribe it through the actual native
runtime. It does not use the microphone. Its temporary audio is deleted and
the latest synthetic result is saved beside the installed runtime. An installer
build alone does not establish that model preparation and speech inference work.

## Updating without losing dictation

Keep the committed changes on the personal fork. Do not install official T3
updates over this app: an official build does not contain the microphone code.
The fork coordinator packages a preview version with no upstream update feed.

With Node 24.13.1 or later in the Node 24 line, Corepack, Docker on the build
host, SSH access and at least 5 GiB free on the Mac:

```sh
export PATH="$HOME/Library/Caches/t3-dictation-build/node/bin:$PATH"
node scripts/update-local-dictation.mjs --sync-upstream --install
```

The PATH entry selects this Mac's installed Node 24.13.1 build runtime. On another
Mac, install the required Node version first.

The command requires a clean checkout, merges `origin/main` into the current
branch, then runs focused speech tests, lint and desktop/web typechecks before
building, and runs the native synthetic speech check on the Mac before packaging.
A conflict or failed check stops packaging. Resolve conflicts and
commit before retrying without `--sync-upstream`. No script can guarantee that
future upstream changes need no adaptation; these checks prevent silently
replacing the fork with an unverified build.

Ordinary builds run in a capped Docker container on `homelab-lan`, using the
managed source mirror `~/t3-dictation-build/source` and cache beside it. The Mac
checkout is authoritative. Source sync excludes credentials, dependencies and
runtime data. The build requires 7 GiB available host memory and uses two CPUs
and at most 6 GiB. Existing containers are left running. Override the SSH alias
with `T3_DICTATION_BUILD_HOST`; an unavailable host stops the command.

The coordinator separately copies only the public Clerk and relay identifiers.
Explicit public settings override the production identifiers in `.env.example`.
Signing assets, provider credentials and telemetry tokens are not copied.

Only the Mac-native speech build, native package installation and app packaging
run on the Mac. The coordinator installs Rust 1.95 for the native resource
monitor without changing the default toolchain; an explicit `RUSTUP_TOOLCHAIN`
overrides that choice. The resulting ZIP is under `release/local-dictation`. Omit
`--install` to build without replacing the installed app. The coordinator applies
an ad hoc local signature to the app and repacks the ZIP. This is a personal
build, without Developer ID signing or notarization. Installation refuses
to proceed while T3 is running, verifies the app signature, rejects an upstream
update feed and preserves the previous app under the speech runtime's
`app-backups` directory. Quit T3 before using `--install`, and retain `~/.t3`.
The coordinator never quits the running app or writes to its live database.
After installation, allow microphone access when prompted and verify a spoken
prompt, Stop, Cancel and a thread switch before discarding the previous app.

Web browsers and the mobile apps retain their existing speech behavior. The
desktop IPC boundary deliberately keeps speech local to the Mac; it does not
add a transcription endpoint to remote environments.
