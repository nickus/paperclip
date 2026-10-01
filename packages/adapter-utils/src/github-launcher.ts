// Git credential settings that managed launchers keep for hosts other than
// GitHub. Only per-URL `credential.<url>.helper`, `.username` and
// `.useHttpPath` entries qualify; unscoped helpers and anything that can
// rewrite or redirect a URL (`url.*.insteadOf`, `core.askPass`, ...) are
// still cleared. These patterns are also embedded in the launcher source.
const OTHER_HOST_CREDENTIAL_KEY = /^credential\.(.+)\.(helper|username|usehttppath)$/i;
// An explicit http(s) URL naming a plain host: no wildcard, percent-encoded
// or empty host, so the host checked here is the one Git matches against.
const OTHER_HOST_CREDENTIAL_URL = /^https?:\/\/(?:[\w.~%+-]+@)?([a-z0-9.-]+)(?::\d{1,5})?(?:[\/?#][\x21-\x7e]*)?$/i;
const CREDENTIAL_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
// github.com and its subdomains (www, gist, ...) belong to managed credentials.
const GITHUB_CREDENTIAL_HOST = /(?:^|\.)github\.com$/;
// Far above any real configuration; larger counts are ignored as malformed.
const MAX_GIT_CONFIG_COUNT = 1024;

/**
 * Credential settings scoped to hosts other than GitHub, read from the
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` entries of
 * `env`, in their original order. Entries at or beyond `GIT_CONFIG_COUNT`,
 * incomplete pairs, and a missing or malformed count contribute nothing.
 *
 * This is how operators give agents HTTPS access to another Git host while
 * GitHub access stays managed, e.g. `credential.https://gitlab.com.helper`
 * pointing at a helper that reads a token from a secret-bound variable.
 */
export function otherHostGitCredentialConfig(env: Record<string, unknown>): Array<[key: string, value: string]> {
  const count = env.GIT_CONFIG_COUNT;
  if (typeof count !== "string" || !/^\d{1,4}$/.test(count) || Number(count) > MAX_GIT_CONFIG_COUNT) return [];
  const entries: Array<[string, string]> = [];
  for (let index = 0; index < Number(count); index++) {
    const key = env[`GIT_CONFIG_KEY_${index}`];
    const value = env[`GIT_CONFIG_VALUE_${index}`];
    if (typeof key !== "string" || typeof value !== "string") continue;
    const scope = OTHER_HOST_CREDENTIAL_KEY.exec(key)?.[1];
    // Git ignores letter case and a trailing root dot in host names.
    const host = scope ? OTHER_HOST_CREDENTIAL_URL.exec(scope)?.[1]?.toLowerCase().replace(/\.$/, "") : undefined;
    if (host && CREDENTIAL_HOST.test(host) && !GITHUB_CREDENTIAL_HOST.test(host)) entries.push([key, value]);
  }
  return entries;
}

/** Standalone source is staged unchanged on local, SSH, and sandbox runtimes. No secrets in files. */
export function githubLauncherSource(): string {
  return String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const directory = path.dirname(fs.realpathSync(process.argv[1]));
const program = path.basename(process.argv[1]);
const originalPath = (process.env.PATH || '').split(path.delimiter).filter(p => {
  try { return fs.realpathSync(p) !== directory; } catch { return true; }
});
const executable = originalPath.map(p => path.join(p, program)).find(p => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
});
if (!['git', 'gh'].includes(program) || !executable) {
  process.stderr.write('Paperclip: requested GitHub command is not installed.\n');
  process.exit(127);
}
// Mirrors otherHostGitCredentialConfig in github-launcher.ts. These entries
// carry no more authority than git -c arguments, which are forwarded as is.
function otherHostCredentialConfig(source) {
  const count = source.GIT_CONFIG_COUNT;
  if (typeof count !== 'string' || !/^\d{1,4}$/.test(count) || Number(count) > ${MAX_GIT_CONFIG_COUNT}) return [];
  const entries = [];
  for (let index = 0; index < Number(count); index++) {
    const key = source['GIT_CONFIG_KEY_' + index], value = source['GIT_CONFIG_VALUE_' + index];
    if (typeof key !== 'string' || typeof value !== 'string') continue;
    const scope = (${OTHER_HOST_CREDENTIAL_KEY}.exec(key) || [])[1];
    const host = scope ? ((${OTHER_HOST_CREDENTIAL_URL}.exec(scope) || [])[1] || '').toLowerCase().replace(/\.$/, '') : '';
    if (host && ${CREDENTIAL_HOST}.test(host) && !${GITHUB_CREDENTIAL_HOST}.test(host)) entries.push([key, value]);
  }
  return entries;
}
async function main() {
  let env = { ...process.env };
  // Read before the inherited Git configuration is cleared below.
  const otherHostCredentials = otherHostCredentialConfig(process.env);
  const diagnostic = (code) => process.stderr.write('Paperclip: GitHub ' + code + '; continuing without managed credentials.\n');
  const configRoot = env.GH_CONFIG_DIR || os.tmpdir();
  // A missing/unwritable scratch directory must not break local Git. The
  // fallback deliberately cannot load the host's gh authentication files.
  let configDirectory = path.join(directory, 'unavailable-gh-config');
  let configReady = false;
  try {
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    configDirectory = fs.mkdtempSync(path.join(configRoot, 'paperclip-github-operation-'));
    fs.chmodSync(configDirectory, 0o700);
    configReady = true;
    process.once('exit', () => { try { fs.rmSync(configDirectory, { recursive: true, force: true }); } catch {} });
  } catch { diagnostic('configuration_directory_unavailable'); }
  {
    for (const key of Object.keys(env)) {
      if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_CONFIG_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*)$/.test(key)) delete env[key];
    }
    Object.assign(env, {
      GH_CONFIG_DIR: configDirectory, SSH_AUTH_SOCK: '',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      // The inherited identity was deleted above. Empty identity env values
      // override even explicit repository/command config and break local commits.
      // Require configured identity instead of guessing the OS user's details.
      GIT_CONFIG_COUNT: '5', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'git@github.com:',
      GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
      GIT_CONFIG_KEY_3: 'core.askPass', GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'user.useConfigOnly', GIT_CONFIG_VALUE_4: 'true',
    });
    const base = env.PAPERCLIP_GITHUB_BROKER_URL || env.PAPERCLIP_API_URL;
    try {
    let response;
    if (base && env.PAPERCLIP_GITHUB_BROKER_TOKEN) {
      const url = base.replace(/\/+$/, '').replace(/\/api$/, '') + '/runtime-tools/github/credentials';
      for (let attempt = 0; attempt < 30; attempt++) {
        response = await fetch(url, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { authorization: 'Bearer ' + (env.PAPERCLIP_GITHUB_BRIDGE_TOKEN || env.PAPERCLIP_API_KEY || env.PAPERCLIP_GITHUB_BROKER_TOKEN),
            'x-paperclip-github-capability': env.PAPERCLIP_GITHUB_BROKER_TOKEN, 'content-type': 'application/json' },
          body: '{}',
        });
        if (response.status !== 409) break;
        await response.arrayBuffer();
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!response.ok) {
        diagnostic(response.status === 401 || response.status === 403 ? 'capability_rejected' : 'broker_response_unavailable');
      } else {
      const result = await response.json();
      if (result.status === 'unavailable') {
        const reason = typeof result.reason === 'string'
          ? result.reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)
          : 'Check the GitHub connection in Paperclip';
        process.stderr.write('Paperclip: GitHub access unavailable: ' + reason + '. Continuing without GitHub credentials.\n');
      }
      if (result.status === 'available' && configReady) {
        for (const [key, value] of Object.entries(result.env || {})) {
          if (/^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/.test(key) && typeof value === 'string') env[key] = value;
        }
      }
      }
    } else { diagnostic('capability_missing'); }
    } catch { diagnostic('broker_transport_unavailable'); }
  }
  // Append other hosts' credential settings after the managed entries: the
  // leading credential.helper reset still clears unscoped helpers, and each
  // URL-scoped entry applies only to requests for its own host.
  if (/^\d+$/.test(env.GIT_CONFIG_COUNT || '')) {
    const base = Number(env.GIT_CONFIG_COUNT);
    otherHostCredentials.forEach(([key, value], offset) => {
      env['GIT_CONFIG_KEY_' + (base + offset)] = key;
      env['GIT_CONFIG_VALUE_' + (base + offset)] = value;
    });
    env.GIT_CONFIG_COUNT = String(base + otherHostCredentials.length);
  }
  // Only this invocation and its children inherit the captured credential.
  // Its Git children use the real binary, so steering cannot split a gh operation.
  env.PATH = originalPath.join(path.delimiter);
  // Nested shell aliases must not reload the parent launcher profile and
  // recapture a newer identity. All ordinary descendants stay in this operation.
  env.ZDOTDIR = configDirectory;
  env.BASH_ENV = '/dev/null';
  env.GIT_SSH_COMMAND = 'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes';
  const child = spawn(executable, process.argv.slice(2), { env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.once('error', () => { process.stderr.write('Paperclip: GitHub command could not start.\n'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code === null ? 128 : code; });
}
main().catch(() => { process.stderr.write('Paperclip: GitHub launcher_setup_failed.\n'); process.exitCode = 1; });
`;
}

/** Override inherited credentials even when adapters merge the host environment later. */
export function githubBrokerEnvironment(input: Record<string, unknown>, broker: { url: string; token: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (typeof value === "string") env[key] = value;
  const otherHostCredentials = otherHostGitCredentialConfig(env);
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PAPERCLIP_GIT_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_COUNT", "PAPERCLIP_GITHUB_OPERATION_ACTIVE"]) env[key] = "";
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) env[key] = "";
  }
  // Other hosts' credential settings stay configured, renumbered from zero so
  // no cleared entry remains in range. Launchers append them to their own.
  otherHostCredentials.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  if (otherHostCredentials.length > 0) env.GIT_CONFIG_COUNT = String(otherHostCredentials.length);
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  env.GIT_SSH_COMMAND = "ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes";
  env.SSH_AUTH_SOCK = "";
  env.PAPERCLIP_GITHUB_BROKER_URL = broker.url;
  env.PAPERCLIP_GITHUB_BROKER_TOKEN = broker.token;
  return env;
}
