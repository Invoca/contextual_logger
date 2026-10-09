#!/usr/bin/env bash
# Provisions the ADLC framework + adlc-cli for environments that cannot use
# Homebrew/SSH (Cursor Cloud Agent VMs). Canonical source; setup.sh deploys
# this file to .cursor/adlc-provision.sh in every consumer.
#
#   .cursor/adlc-provision.sh            # download + activate (idempotent)
#   .cursor/adlc-provision.sh download   # cache only, activate nothing
#   .cursor/adlc-provision.sh activate   # link cached versions; no network
#   .cursor/adlc-provision.sh verify     # report status only
#
# Credentials: ADLC_GH_TOKEN only. Never GH_TOKEN / GITHUB_TOKEN.
# Fine-grained Contents:Read on Invoca/ADLC only — adlc-cli/ ships as part of
# this repo's own tarball, so there is no second repo to grant access to.
# No ADLC_CLOUD gate — ADLC-on consumers (Titan, web) activate on Cloud
# when the cache exists or a download succeeds.
#
# Sanctioned TypeScript exception: environment.json invokes this before Node
# is guaranteed. Do not treat as precedent.
set -euo pipefail

find_repo_root() {
  local d
  d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while [ "$d" != "/" ]; do
    if [ -f "$d/.adlc-version" ] || [ -d "$d/.git" ]; then
      printf '%s' "$d"
      return 0
    fi
    d="$(dirname "$d")"
  done
  return 1
}

REPO_ROOT="$(find_repo_root)" || { echo "adlc-provision: cannot find repo root" >&2; exit 1; }
cd "$REPO_ROOT"

ADLC_REPO="${ADLC_REPO:-Invoca/ADLC}"
INSTALL_ROOT="${ADLC_INSTALL_ROOT:-$HOME/.adlc-framework}"

log()  { printf 'adlc-provision: %s\n' "$1"; }
warn() { printf 'adlc-provision: %s\n' "$1" >&2; }

CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-10}"
CURL_MAX_TIME="${CURL_MAX_TIME:-60}"

# Follows 302s when callers pass -L / --location (fetch_by_token and the
# release-asset GET do). curl strips Authorization when the host changes
# (asset calls 302 to release-assets.githubusercontent.com). That is safe.
# Never add --location-trusted — that would forward ADLC_GH_TOKEN to the CDN.
timed_curl() {
  curl --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" "$@"
}

# Inject exists: tests may export adlc_dir_exists before invoking this script.
# Production uses [ -d ]. No env override for the probe path.
if ! declare -F adlc_dir_exists >/dev/null 2>&1; then
  adlc_dir_exists() { [ -d "$1" ]; }
fi

# Match adlc/methods/hooks/cursor-cloud.ts: structural paths /exec-daemon and
# /workspace are sufficient. CURSOR_AGENT is not required — exec-daemon injects
# it into Shell children only, not hook subprocesses. Not ADLC_CLOUD.
# No env probe override.
is_cloud_session() {
  adlc_dir_exists /exec-daemon && adlc_dir_exists /workspace
}

read_pin() {
  [ -f .adlc-version ] || { warn "no .adlc-version at repo root"; return 1; }
  tr -d '[:space:]' < .adlc-version
}

# ADLC_GH_TOKEN is the only token variable consulted. GH_TOKEN and
# GITHUB_TOKEN are never read for fetch — gh may already be authenticated
# independently; we do not pass those names into curl.
fetch_by_token() {
  local url="$1" out="$2" token="$3"
  timed_curl -sSL --fail \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.github+json" \
    "$url" -o "$out" \
    && [ -s "$out" ]
}

fetch_tarball() {
  local tag="$1" out="$2"
  if [ -n "${ADLC_GH_TOKEN:-}" ]; then
    fetch_by_token "https://api.github.com/repos/${ADLC_REPO}/tarball/${tag}" "$out" "$ADLC_GH_TOKEN" && return 0
  fi
  warn "ADLC_GH_TOKEN is unset; cannot fetch ${ADLC_REPO} tarball ${tag}."
  warn "  Set ADLC_GH_TOKEN (fine-grained Contents:Read on ${ADLC_REPO})."
  warn "  Ambient gh is launch-repo-scoped and cannot read ${ADLC_REPO}."
  return 1
}

# Extract a top-level JSON string field's value without jq (this script runs
# before Node/jq are guaranteed on a bare Cursor Cloud VM). Only safe against
# a known, small, single-object response shape -- callers below only ever
# feed it the specific GitHub API responses this was written against.
json_field() {
  local field="$1" json="$2"
  printf '%s' "$json" | grep -o "\"${field}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed -E 's/.*"([^"]*)"$/\1/'
}

# Resolves a tag name to the immutable commit SHA it currently points at, so
# `download_framework` fetches by that SHA rather than by the movable tag
# name — a tag ref can be force-moved between the resolve and the fetch (or
# have already been moved before either), reintroducing the same TOCTOU a
# by-SHA fetch closes. Fails closed (returns 1, no SHA printed) rather than
# guess on anything unexpected: a missing/malformed response, or a tag
# object.type other than "commit" (an annotated tag one hop away from its
# commit) -- ADLC's own release tags are lightweight (object.type: "commit"
# directly), confirmed against the live API, so an annotated tag here would
# itself be unexpected and is refused rather than silently mis-resolved via
# fragile no-jq nested-field parsing.
resolve_tag_commit_sha() {
  local tag="$1" token="$2" response obj_type obj_sha
  response="$(timed_curl -sSL --fail \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${ADLC_REPO}/git/refs/tags/${tag}")" || return 1
  obj_type="$(json_field type "$response")"
  obj_sha="$(json_field sha "$response")"
  if [ "$obj_type" != "commit" ] || [ -z "$obj_sha" ]; then
    warn "tag ${tag} did not resolve to a plain commit object (got type '${obj_type:-empty}') -- refusing to guess a commit SHA."
    return 1
  fi
  printf '%s' "$obj_sha"
}

download_framework() {
  local pin dest tarball tmp got sha fetch_ref
  pin="$(read_pin)" || return 1
  dest="$INSTALL_ROOT/$pin"

  if [ -f "$dest/adlc/methods/session-rules.md" ]; then
    log "ADLC $pin already cached at $dest"
    return 0
  fi

  # Resolve v$pin to its current commit SHA and fetch by that SHA, not the
  # tag name — a tag is movable (accidentally or maliciously), so fetching
  # "by tag" trusts whatever it points to at the exact moment of the GET,
  # with no way to verify after the fact. Fetching by SHA fetches an
  # immutable git object: the content is exactly what that SHA names,
  # independent of anything happening to the tag before or after. Degrades
  # to fetching by tag name only if resolution itself fails (e.g. ADLC_GH_TOKEN
  # unset) — fetch_tarball's own warnings already cover that path.
  fetch_ref="v$pin"
  if [ -n "${ADLC_GH_TOKEN:-}" ]; then
    if sha="$(resolve_tag_commit_sha "v$pin" "$ADLC_GH_TOKEN")" && [ -n "$sha" ]; then
      fetch_ref="$sha"
    else
      warn "could not resolve tag v$pin to a commit SHA; falling back to fetching by tag name (movable-tag exposure)."
    fi
  fi

  log "downloading ADLC $pin from ${ADLC_REPO} (${fetch_ref})"
  tarball="$(mktemp -t adlc-XXXXXX.tar.gz)"
  if ! fetch_tarball "$fetch_ref" "$tarball"; then
    rm -f "$tarball"
    if [ "${ADLC_PROVISION_PHASE:-}" = "build" ]; then
      log "ADLC v$pin not cached at build time; start.sh will fetch on demand."
      return 1
    fi
    warn "could not download ADLC v$pin from ${ADLC_REPO}. Set ADLC_GH_TOKEN"
    warn "  (fine-grained Contents:Read on ${ADLC_REPO})."
    return 1
  fi

  tmp="$(mktemp -d -t adlc-extract-XXXXXX)"
  tar -xzf "$tarball" -C "$tmp" --strip-components=1
  rm -f "$tarball"

  if [ ! -f "$tmp/adlc/methods/session-rules.md" ]; then
    rm -rf "$tmp"
    warn "downloaded archive does not look like ADLC"
    return 1
  fi

  got="$(tr -d '[:space:]' < "$tmp/.adlc-version" 2>/dev/null || true)"
  if [ -n "$got" ] && [ "$got" != "$pin" ]; then
    rm -rf "$tmp"
    warn "tag v$pin contains version $got; refusing mismatched framework"
    return 1
  fi

  mkdir -p "$INSTALL_ROOT"
  rm -rf "$dest"
  mv "$tmp" "$dest"
  log "cached ADLC $pin at $dest (not active until linked)"
}

# Persist a line into ~/.bashrc and ~/.profile, creating the files when
# missing (fresh Cloud VMs often have neither). Needle is the grep -F
# haystack so PATH can match ${INSTALL_ROOT}/bin rather than the
# whole export line.
persist_cloud_rc_line() {
  local needle="$1" line="$2" rc
  for rc in "$HOME/.bashrc" "$HOME/.profile"; do
    [ -f "$rc" ] || touch "$rc" 2>/dev/null || continue
    if ! grep -qsF "$needle" "$rc" 2>/dev/null; then
      printf '%s\n' "$line" >> "$rc"
    fi
  done
}

# install_onto_path's export PATH only lives in this child process.
# Do not sudo-link /usr/local/bin: Cloud VMs lack passwordless sudo, and
# persist_cli_bin_on_path already puts $INSTALL_ROOT/bin on PATH for
# later shells.
persist_cli_bin_on_path() {
  is_cloud_session || return 0
  persist_cloud_rc_line \
    "${INSTALL_ROOT}/bin" \
    "export PATH=\"${INSTALL_ROOT}/bin:\$PATH\""
}

install_onto_path() {
  local src="$1" name="$2" bin="$INSTALL_ROOT/bin"
  mkdir -p "$bin"
  ln -sfn "$src" "$bin/$name"
  export PATH="$bin:$PATH"
  persist_cli_bin_on_path
}

activate_framework() {
  local pin dest
  pin="$(read_pin)" || return 1
  dest="$INSTALL_ROOT/$pin"
  if [ ! -f "$dest/adlc/methods/session-rules.md" ]; then
    warn "ADLC $pin is not cached at $dest"
    return 1
  fi
  if [ -L adlc ]; then
    rm -f adlc
  elif [ -e adlc ]; then
    warn "./adlc already exists as a real directory — remove/back it up before activating (symlink activate expects to create adlc/ as a link)."
    return 1
  fi
  ln -sfn "$dest/adlc" adlc
  log "linked ./adlc -> $dest/adlc"
  if [ -f "$dest/adlc/methods/hooks/adlc-meter.ts" ]; then
    install_onto_path "$dest/adlc/methods/hooks/adlc-meter.ts" adlc-meter || true
  fi
}

# Resolve a working bun the same two ways adlc-cli/bin/adlc-cli's own
# resolve_bun() does (PATH first, then the well-known default install
# location), installing the pinned/checksum-verified version via the cached
# adlc-cli/scripts/install-bun.sh when neither resolves. This is a genuinely
# new runtime requirement Cursor Cloud did not have when adlc-cli shipped as
# a compiled binary with no interpreter dependency at all.
ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    return 0
  fi
  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
    return 0
  fi
  local pin installer
  pin="$(read_pin)" || return 1
  installer="$INSTALL_ROOT/$pin/adlc-cli/scripts/install-bun.sh"
  if [ ! -x "$installer" ]; then
    warn "no bun on PATH or at \$HOME/.bun/bin/bun, and $installer is not cached to install one"
    return 1
  fi
  log "no bun found; installing the pinned version via $installer"
  "$installer" || { warn "install-bun.sh failed"; return 1; }
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun >/dev/null 2>&1
}

# Activates adlc-cli straight out of the already-cached framework tarball —
# no second download, no second pin. adlc-cli/'s own product surface
# (bin/src/package.json/.bun-version/scripts) rides download_framework()'s
# tarball because it now lives inside Invoca/ADLC.
provision_cli() {
  local pin dest
  pin="$(read_pin)" || return 1
  dest="$INSTALL_ROOT/$pin/adlc-cli"
  if [ ! -x "$dest/bin/adlc-cli" ]; then
    warn "adlc-cli is not cached at $dest (framework pin $pin not downloaded/cached)"
    return 1
  fi
  ensure_bun || return 1
  install_onto_path "$dest/bin/adlc-cli" adlc-cli
  if is_cloud_session; then
    export ADLC_CLI_WORKTREE_SHAPE=in-repo
    local line='export ADLC_CLI_WORKTREE_SHAPE=in-repo'
    persist_cloud_rc_line "$line" "$line"
    persist_cli_bin_on_path
    log "ADLC_CLI_WORKTREE_SHAPE=in-repo (Cursor Cloud runner-static)"
  fi
}

verify() {
  local pin rc=0
  pin="$(read_pin)" || return 1
  printf '  pin (.adlc-version)   : %s\n' "$pin"
  printf '  ADLC_CLOUD            : %s (not required)\n' "${ADLC_CLOUD:-unset}"
  printf '  ADLC_GH_TOKEN         : %s\n' "$( [ -n "${ADLC_GH_TOKEN:-}" ] && printf set || printf unset )"
  if [ ! -e adlc ]; then
    printf '  adlc/                 : MISSING\n'
    rc=1
  elif [ -L adlc ]; then
    local target expected
    target="$(readlink adlc)"
    expected="$INSTALL_ROOT/$pin/adlc"
    if [ "$target" = "$expected" ]; then
      printf '  adlc/                 : symlink -> %s\n' "$target"
    else
      printf '  adlc/                 : STALE symlink -> %s (pin expects %s)\n' "$target" "$expected"
      rc=1
    fi
  else
    printf '  adlc/                 : WRONG-SHAPE (real directory, not a symlink)\n'
    rc=1
  fi
  if command -v adlc-cli >/dev/null 2>&1; then
    printf '  adlc-cli on PATH      : %s\n' "$(command -v adlc-cli)"
  else
    printf '  adlc-cli on PATH      : MISSING\n'
    rc=1
  fi
  if [ "$rc" -eq 0 ]; then
    printf '\nPASS: ADLC %s and adlc-cli are active.\n' "$pin"
  else
    printf '\nFAIL: run .cursor/adlc-provision.sh (requires ADLC_GH_TOKEN for download).\n'
  fi
  return "$rc"
}

# One shared framework-cache fetch (adlc-cli/ rides the same tarball, no
# second download or pin), then a lightweight local activation step. Let
# verify() decide the exit code: it is the one place that knows whether the
# linked framework matches the pin and adlc-cli is really on PATH. Callers
# that want a non-fatal start step wrap this in `|| true` themselves.
provision() {
  download_framework || true
  if [ -f "$INSTALL_ROOT/$(read_pin 2>/dev/null || true)/adlc/methods/session-rules.md" ]; then
    activate_framework || true
    provision_cli || true
  fi
  verify
}

case "${1:-provision}" in
  verify)    verify ;;
  download)  download_framework ;;
  activate)  activate_framework || true; provision_cli || true; verify ;;
  provision) provision ;;
  *)         warn "usage: ${BASH_SOURCE[0]} [provision|download|activate|verify]"; exit 64 ;;
esac
