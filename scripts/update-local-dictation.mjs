import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { loadRepoEnv } from "./lib/public-config.ts";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
if (args.has("--help")) {
  console.log(
    "node scripts/update-local-dictation.mjs [--sync-upstream] [--install]\nBuilds and verifies the dictation fork without an upstream update feed. Installation requires T3 to be closed and preserves the previous app for rollback.",
  );
  process.exit(0);
}
for (const arg of args)
  if (arg !== "--sync-upstream" && arg !== "--install") throw new Error(`Unknown option: ${arg}`);
// oxlint-disable-next-line t3code/no-global-process-runtime -- The coordinator must run without installed workspace dependencies.
if (NodeOS.platform() !== "darwin" || NodeOS.arch() !== "arm64")
  throw new Error("Run this coordinator on the Apple Silicon Mac.");
const host = process.env.T3_DICTATION_BUILD_HOST ?? "homelab-lan";
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host))
  throw new Error("Use an SSH host alias for T3_DICTATION_BUILD_HOST.");
const run = (command, argv, options = {}) =>
  NodeChildProcess.execFileSync(command, argv, {
    cwd: root,
    stdio: options.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    ...options,
  });
const read = (command, argv) =>
  NodeChildProcess.execFileSync(command, argv, { cwd: root, encoding: "utf8" }).trim();
if (args.has("--sync-upstream")) {
  if (read("git", ["status", "--porcelain"]))
    throw new Error("Commit or move local changes before merging upstream.");
  if (
    read("git", ["remote", "get-url", "origin"]).replace(/\.git$/, "") !==
    "https://github.com/pingdotgg/t3code"
  ) {
    throw new Error("Inspect origin before using the upstream merge command.");
  }
  run("git", ["fetch", "origin", "main"]);
  run("git", ["merge", "--no-edit", "origin/main"]);
}
const free = await NodeFSP.statfs(root);
if (free.bavail * free.bsize < 5 * 1024 ** 3)
  throw new Error("Free 5 GiB on the Mac before packaging. No app files have been changed.");
const upstreamVersion = JSON.parse(
  await NodeFSP.readFile(NodePath.join(root, "apps/server/package.json"), "utf8"),
).version;
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(upstreamVersion))
  throw new Error("Inspect the server package version before building.");
const version = `${upstreamVersion.split(/[+-]/)[0]}-preview.${new Date().toISOString().slice(0, 10).replaceAll("-", "")}.${Math.floor(Date.now() / 1000)}`;
const defaults = NodeUtil.parseEnv(
  await NodeFSP.readFile(NodePath.join(root, ".env.example"), "utf8"),
);
const configured = loadRepoEnv();
const publicConfig = Object.fromEntries(
  [
    "T3CODE_CLERK_PUBLISHABLE_KEY",
    "T3CODE_CLERK_JWT_TEMPLATE",
    "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
    "T3CODE_RELAY_URL",
  ]
    .map((key) => [key, configured[key] ?? defaults[key]])
    .filter((entry) => typeof entry[1] === "string"),
);
run("ssh", [host, "mkdir -p ~/t3-dictation-build/source ~/t3-dictation-build/cache"]);
run("rsync", [
  "-az",
  "--delete",
  ...[
    "node_modules",
    ".git",
    ".env",
    ".env.*",
    ".t3",
    ".repos",
    "dist",
    "dist-electron",
    ".electron-runtime",
    ".vite-plus",
    ".astro",
    "*.tsbuildinfo",
    "release",
    ".plans",
    ".claude",
    ".codex",
    ".runtime",
    ".expo",
    ".npmrc",
    "*.p12",
    "*.pfx",
    "*.mobileprovision",
  ].flatMap((name) => ["--exclude", name]),
  `${root}/`,
  `${host}:t3-dictation-build/source/`,
]);
run("ssh", [host, "umask 077; cat > ~/t3-dictation-build/source/.env"], {
  input:
    Object.entries(publicConfig)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
});
run("ssh", [host, "bash -s"], {
  input: `set -euo pipefail
hostname
uptime
free -m
docker ps --format '{{.Names}} {{.Status}}'
test "$(awk '/MemAvailable/ {print $2}' /proc/meminfo)" -gt 7340032
docker run --rm -i --name t3-dictation-build --cpus 2 --memory 6g --memory-swap 6g --user "$(id -u):$(id -g)" \\
  -e HOME=/cache -e NODE_OPTIONS=--max-old-space-size=3072 -e APP_VERSION=${version} \\
  -v "$HOME/t3-dictation-build/source:/workspace" -v "$HOME/t3-dictation-build/cache:/cache" \\
  -w /workspace node:24.13.1-bookworm bash -se <<'CONTAINER'
export PATH=/workspace/node_modules/.bin:$PATH
npm exec --yes --package=pnpm@11.10.0 -- pnpm install --frozen-lockfile
vp test run apps/desktop/src/dictation/localTranscription.test.ts apps/web/src/components/chat/dictationAudio.test.ts packages/client-runtime/src/voice-input/controller.test.ts
vp test run scripts/build-desktop-artifact.test.ts -t 'omits update feeds'
vp lint apps/desktop/src/dictation apps/desktop/src/ipc/methods/dictation.ts apps/web/src/components/chat/DesktopDictation.tsx apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/chat/dictationCapture.worklet.js apps/web/src/components/chat/dictationAudio.ts apps/web/src/components/chat/dictationAudio.test.ts
(cd apps/desktop && tsc-rs --noEmit)
(cd apps/web && tsc-rs --noEmit)
node scripts/update-release-package-versions.ts "$APP_VERSION"
vp run --filter t3 build
cd apps/desktop
node scripts/build-preview-annotation-css.mjs
vp pack
CONTAINER
`,
});
for (const directory of ["apps/server/dist", "apps/desktop/dist-electron"]) {
  await NodeFSP.mkdir(NodePath.join(root, directory), { recursive: true });
  run("rsync", [
    "-az",
    "--delete",
    `${host}:t3-dictation-build/source/${directory}/`,
    `${root}/${directory}/`,
  ]);
}
run("corepack", [
  "pnpm",
  "--filter",
  "@t3tools/monorepo",
  "--filter",
  "@t3tools/scripts...",
  "--filter",
  "@t3tools/desktop...",
  "install",
  "--frozen-lockfile",
]);
run(process.execPath, ["scripts/setup-local-dictation.mjs"]);
run(process.execPath, ["scripts/check-local-dictation.mjs"]);
run(process.execPath, ["apps/desktop/scripts/build-browser-secret.mjs"]);
run(process.execPath, ["apps/desktop/scripts/build-preview-annotation-css.mjs"]);
const rustToolchain = process.env.RUSTUP_TOOLCHAIN ?? "1.95.0";
if (!process.env.RUSTUP_TOOLCHAIN)
  run("rustup", ["toolchain", "install", rustToolchain, "--profile", "minimal"]);
run(
  process.execPath,
  [
    "scripts/build-desktop-artifact.ts",
    "--platform",
    "mac",
    "--arch",
    "arm64",
    "--target",
    "zip",
    "--skip-build",
    "--build-version",
    version,
    "--output-dir",
    "release/local-dictation",
  ],
  {
    env: {
      ...process.env,
      ...publicConfig,
      PATH: `${NodePath.join(root, "node_modules/.bin")}${NodePath.delimiter}${process.env.PATH ?? ""}`,
      RUSTUP_TOOLCHAIN: rustToolchain,
      CARGO_BUILD_JOBS: "2",
    },
  },
);
const desktopManifest = JSON.parse(
  await NodeFSP.readFile(NodePath.join(root, "apps/desktop/package.json"), "utf8"),
);
const appName = desktopManifest.productName ?? "T3 Code";
const archive = NodePath.join(root, "release/local-dictation", `T3-Code-${version}-arm64.zip`);
const unpacked = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-dictation-install-"));
try {
  run("ditto", ["-x", "-k", archive, unpacked]);
  const builtApp = NodePath.join(unpacked, `${appName}.app`);
  await NodeFSP.access(builtApp);
  const hasUpdateFeed = await NodeFSP.access(
    NodePath.join(builtApp, "Contents/Resources/app-update.yml"),
  ).then(
    () => true,
    () => false,
  );
  if (hasUpdateFeed)
    throw new Error("The fork unexpectedly contains an automatic update feed. Do not install it.");
  const { sign } = await import("@electron/osx-sign");
  await sign({
    app: builtApp,
    identity: "-",
    identityValidation: false,
    preAutoEntitlements: false,
    optionsForFile: () => ({ hardenedRuntime: false }),
  });
  run("codesign", ["--verify", "--deep", "--strict", builtApp]);
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", builtApp, archive]);
  await NodeFSP.rm(`${archive}.blockmap`, { force: true });
  if (args.has("--install")) {
    const installedApp = NodePath.join("/Applications", `${appName}.app`);
    const processes = read("ps", ["-axww", "-o", "comm"]).split("\n");
    if (
      processes.some(
        (command) =>
          command.startsWith(`${installedApp}/`) || NodePath.basename(command) === appName,
      )
    )
      throw new Error(
        "Quit T3 before installing the verified fork, then run this command again with --install.",
      );
    const installed = await NodeFSP.access(installedApp).then(
      () => true,
      () => false,
    );
    const backup = NodePath.join(
      NodeOS.homedir(),
      "Library/Application Support/T3Dictation/app-backups",
      version,
      `${appName}.app`,
    );
    if (installed) {
      const identity = read("plutil", [
        "-extract",
        "CFBundleIdentifier",
        "raw",
        NodePath.join(installedApp, "Contents/Info.plist"),
      ]);
      if (identity !== "com.t3tools.t3code")
        throw new Error("Inspect the existing app identity before replacing it.");
    }
    const stagedApp = NodePath.join("/Applications", `.${appName}.dictation-${Date.now()}.app`);
    try {
      run("ditto", [builtApp, stagedApp]);
      run("codesign", ["--verify", "--deep", "--strict", stagedApp]);
      if (installed) {
        await NodeFSP.mkdir(NodePath.dirname(backup), { recursive: true });
        await NodeFSP.rename(installedApp, backup);
      }
      try {
        await NodeFSP.rename(stagedApp, installedApp);
      } catch (error) {
        if (installed) await NodeFSP.rename(backup, installedApp);
        throw error;
      }
    } finally {
      await NodeFSP.rm(stagedApp, { force: true, recursive: true });
    }
    console.log(
      `Installed ${installedApp}. Previous app: ${installed ? backup : "none"}. T3 was not launched.`,
    );
  }
} finally {
  await NodeFSP.rm(unpacked, { force: true, recursive: true });
}

console.log(
  `Verified fork ${read("git", ["rev-parse", "--short", "HEAD"])} packaged in release/local-dictation. The running app was left untouched.`,
);
