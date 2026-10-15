#!/bin/sh
# curl -fsSL https://raw.githubusercontent.com/huacnlee/gpui-shell-benchs/main/install.sh | sh
#
# Installs applications from a GitHub Release into ~/.gpui-shell/apps, and gives
# each an application entry: a .app in ~/Applications on macOS, a launcher
# entry on Linux. Without application names it lists them and asks.
set -eu

repo=huacnlee/gpui-shell-benchs
tag=''
all=false
list=false
names=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { echo '--version needs a release tag, such as v0.2.0' >&2; exit 1; }
      tag=$2
      shift 2 ;;
    --all) all=true; shift ;;
    --list) list=true; shift ;;
    --help|-h)
      echo 'Usage: sh install.sh [--version tag] [--all | --list | app...]'
      exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) names="$names $1"; shift ;;
  esac
done

for utility in curl tar mktemp; do
  command -v "$utility" >/dev/null 2>&1 || { echo "Missing dependency: $utility" >&2; exit 1; }
done
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  echo 'Missing dependency: sha256sum or shasum' >&2
  exit 1
fi

fetch() {
  curl --fail --show-error --silent --location --retry 3 "$1" -o "$2"
}

if [ -z "$tag" ]; then
  # The latest release page redirects to its tag; this avoids the API rate limit.
  latest=$(curl --fail --silent --show-error --head --retry 3 --output /dev/null \
    --write-out '%{redirect_url}' "https://github.com/$repo/releases/latest")
  tag=${latest##*/}
  case "$tag" in
    v*) ;;
    *) echo 'Could not find the latest release.' >&2; exit 1 ;;
  esac
fi

# `bundle` makes the macOS .app or Linux launcher entry; older builds lack it.
runtime=''
for candidate in "$(command -v gpui-shell 2>/dev/null || true)" ~/.local/bin/gpui-shell \
  ~/.cargo/bin/gpui-shell /opt/homebrew/bin/gpui-shell /usr/local/bin/gpui-shell; do
  if [ -x "$candidate" ] && "$candidate" --help 2>&1 | grep -q 'gpui-shell bundle'; then
    runtime=$candidate
    break
  fi
done
if [ -z "$runtime" ]; then
  echo 'Needs a gpui-shell with the bundle command. Install the latest runtime with:' >&2
  echo '  cargo install --git https://github.com/longbridge/gpui-kit gpui-shell --locked' >&2
  exit 1
fi
installed=''
failed=''

apps_dir=~/.gpui-shell/apps
mkdir -p "$apps_dir"
stage=$(mktemp -d ~/.gpui-shell/.install.XXXXXX)
trap 'rm -rf "$stage"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

base="https://github.com/$repo/releases/download/$tag"
fetch "$base/SHA256SUMS" "$stage/SHA256SUMS"
# Every archive is named <app>-<tag>.tar.gz.
available=$(sed -n "s/^[0-9a-f]\{64\}  \(.*\)-$tag\.tar\.gz\$/\1/p" "$stage/SHA256SUMS")
[ -n "$available" ] || { echo "Release $tag has no applications." >&2; exit 1; }

if $list; then
  echo "$available"
  exit 0
fi

if $all; then
  names=$available
elif [ -z "$names" ]; then
  # Read the answer from the terminal; standard input is the script under curl | sh.
  [ -r /dev/tty ] || { echo 'No terminal to ask on; pass application names or --all.' >&2; exit 1; }
  echo "Applications in $tag:"
  index=0
  for app in $available; do
    index=$((index + 1))
    mark=''
    [ -d "$apps_dir/$app" ] && mark=' (installed)'
    printf '  %2d) %s%s\n' "$index" "$app" "$mark"
  done
  printf 'Install which? Numbers or names separated by spaces, or "all": '
  read -r answer </dev/tty
  [ -n "$answer" ] || { echo 'Nothing selected.'; exit 0; }
  if [ "$answer" = all ]; then
    names=$available
  else
    for choice in $answer; do
      case "$choice" in
        *[!0-9]*) names="$names $choice" ;;
        *)
          app=$(echo "$available" | sed -n "${choice}p")
          [ -n "$app" ] || { echo "No application numbered $choice." >&2; exit 1; }
          names="$names $app" ;;
      esac
    done
  fi
fi

# Validate every name before downloading anything.
for app in $names; do
  echo "$available" | grep -qx "$app" || { echo "Release $tag has no application named $app." >&2; exit 1; }
done

system=$(uname -s)
case "$system" in
  Darwin) launcher_dir=~/Applications ;;
  Linux) launcher_dir=~/.local/share/applications ;;
  *) echo "Application entries are made for macOS and Linux, not $system." >&2; exit 1 ;;
esac
# Bundle launchers accept any gpui-shell reporting 0.7.3, and try ~/.local/bin
# first, but the 0.7.3 release lacks `run --packaged` and ${homeDir}. Make the
# launcher try the runtime that just checked and bundled the app first.
pin_runtime() {
  quoted=$(printf '%s' "$runtime" | sed "s/'/'\\\\''/g")
  sed "s|^  for candidate in ~/.local/bin/gpui-shell |  for candidate in '$quoted' ~/.local/bin/gpui-shell |" "$1" >"$1.pinned"
  cat "$1.pinned" >"$1"
  rm -f "$1.pinned"
}
bundle_id() { /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null || true; }

for app in $names; do
  archive="$app-$tag.tar.gz"
  echo "Downloading ${archive}…"
  fetch "$base/$archive" "$stage/$archive"
  expected=$(sed -n "s/^\([0-9a-f]\{64\}\)  $archive\$/\1/p" "$stage/SHA256SUMS")
  [ "$(sha256 "$stage/$archive")" = "$expected" ] || { echo "Checksum mismatch: $archive" >&2; exit 1; }
  mkdir "$stage/$app.unpack"
  tar -xzf "$stage/$archive" -C "$stage/$app.unpack"
  source_dir="$stage/$app.unpack/$app"
  [ -f "$source_dir/gpui-shell.json" ] || { echo "$archive is not a gpui-shell application." >&2; exit 1; }
  # Runtime builds share a version number, so only loading the app shows
  # whether this gpui-shell understands its manifest.
  if ! "$runtime" check -d "$source_dir" >"$stage/check.log" 2>&1; then
    tail -n 3 "$stage/check.log" >&2
    failed="$failed $app"
    continue
  fi

  # Application data lives under the manifest id, so replacing the directory keeps it.
  rm -rf "$apps_dir/$app"
  cp -R "$source_dir" "$apps_dir/$app"

  out="$stage/$app.bundle"
  "$runtime" bundle -d "$source_dir" --out "$out" >"$stage/bundle.log" 2>&1 || {
    cat "$stage/bundle.log" >&2
    failed="$failed $app"
    continue
  }
  if [ "$system" = Darwin ]; then
    bundle=$(find "$out" -maxdepth 1 -name '*.app' | head -n 1)
    destination="$launcher_dir/${bundle##*/}"
    if [ -L "$destination" ] || { [ -e "$destination" ] && [ "$(bundle_id "$destination")" != "$(bundle_id "$bundle")" ]; }; then
      echo "Not replacing $destination, which is a different application." >&2
      failed="$failed $app"
      continue
    fi
    pin_runtime "$bundle/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$bundle/Contents/Info.plist")"
    mkdir -p "$launcher_dir"
    rm -rf "$destination"
    mv "$bundle" "$destination"
    echo "Installed ${app} → $destination"
  else
    # The bundle's own installer adds the launcher entry and a command in ~/.local/bin.
    sh "$out/install.sh" "$(find "$out" -maxdepth 1 -name '*.tar.gz' | head -n 1)" >"$stage/bundle.log" 2>&1 || {
      cat "$stage/bundle.log" >&2
      failed="$failed $app"
      continue
    }
    id=$(sed -n "s/^id='\(.*\)'\$/\1/p" "$out/install.sh")
    command_name=$(sed -n "s/^command_name='\(.*\)'\$/\1/p" "$out/install.sh")
    pin_runtime ~/.local/share/"$id/$command_name"
    echo "Installed ${app} → $launcher_dir"
  fi
  installed="$installed $app"
done

echo
if [ -n "$failed" ]; then
  echo "Could not install:$failed" >&2
  echo "If $runtime is older than these applications, update it with:" >&2
  echo '  cargo install --git https://github.com/longbridge/gpui-kit gpui-shell --locked' >&2
  echo >&2
fi
if [ -n "$installed" ]; then
  if [ "$system" = Darwin ]; then
    echo 'Open them from ~/Applications (Launchpad or Spotlight), or run:'
  else
    echo 'Open them from your application launcher, or run:'
  fi
  for app in $installed; do
    echo "  gpui-shell run $app"
  done
fi
[ -z "$failed" ]
