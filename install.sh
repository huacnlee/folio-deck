#!/bin/sh
# curl -fsSL https://raw.githubusercontent.com/huacnlee/folio-mail/main/install.sh | sh
set -eu

app_source=''
launch=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app-source)
      [ "$#" -ge 2 ] || { echo '--app-source needs a local directory' >&2; exit 1; }
      app_source=$(cd "$2" && pwd -P)
      shift 2 ;;
    --launch) launch=true; shift ;;
    --help)
      echo 'Usage: sh install.sh [--app-source directory] [--launch]'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

case "$(uname -s)" in
  Linux) system=linux; target=x86_64-unknown-linux-gnu ;;
  Darwin)
    system=macos
    case "$(uname -m)" in
      arm64 | aarch64) target=aarch64-apple-darwin ;;
      x86_64) target=x86_64-apple-darwin ;;
      *) echo 'Unsupported macOS architecture' >&2; exit 1 ;;
    esac ;;
  *) echo 'Folio Desk supports Linux and macOS.' >&2; exit 1 ;;
esac
if [ "$system" = linux ] && [ "$(uname -m)" != x86_64 ]; then
  echo 'The gpui-shell release currently provides Linux binaries for x86_64 only.' >&2
  exit 1
fi
for utility in curl tar install mktemp; do
  command -v "$utility" >/dev/null 2>&1 || { echo "Missing dependency: $utility" >&2; exit 1; }
done
if [ "$system" = linux ]; then
  command -v xdg-mime >/dev/null 2>&1 || { echo 'Install xdg-utils for the launch link.' >&2; exit 1; }
else
  command -v osacompile >/dev/null 2>&1 || { echo 'Missing macOS osacompile.' >&2; exit 1; }
fi

# Tilde resolves the current account; no environment overrides or PATH changes.
bin_dir=~/.local/bin
apps_dir=~/.gpui-shell/apps
app_dir=~/.gpui-shell/apps/folio-mail
mkdir -p "$bin_dir" "$apps_dir"
stage=$(mktemp -d ~/.gpui-shell/.folio-install.XXXXXX)
trap 'rm -rf "$stage"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

shell_path="$bin_dir/gpui-shell"
current_version=$({ "$shell_path" --version 2>/dev/null || true; } | awk '{print $2}')
if ! printf '%s\n' "$current_version" | awk -F. 'NF == 3 && ($1 > 0 || $2 > 7 || ($2 == 7 && $3 >= 3)) { found=1 } END {exit !found}'; then
  asset="gpui-shell-$target.tar.gz"
  release="https://github.com/longbridge/gpui-kit/releases/download/v0.7.3/$asset"
  echo 'Installing gpui-shell v0.7.3…'
  curl --fail --show-error --silent --location --retry 3 "$release" -o "$stage/$asset"
  curl --fail --show-error --silent --location --retry 3 "$release.sha256" -o "$stage/$asset.sha256"
  (
    cd "$stage"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum -c "$asset.sha256"
    elif command -v shasum >/dev/null 2>&1; then
      shasum -a 256 -c "$asset.sha256"
    else
      echo 'Missing SHA-256 verifier (sha256sum or shasum).' >&2
      exit 1
    fi
  )
  tar -xzf "$stage/$asset" -C "$stage"
  install -m 755 "$stage/gpui-shell-$target/gpui-shell" "$stage/gpui-shell"
  "$stage/gpui-shell" --version
  install -m 755 "$stage/gpui-shell" "$shell_path"
else
  echo "Using gpui-shell $current_version"
fi

mkdir "$stage/app"
if [ -n "$app_source" ]; then
  # Copy only application assets; exclude Git history and unrelated local files.
  cp "$app_source/main.js" "$app_source/mailbox.js" "$app_source/theme.js" "$app_source/gpui-shell.json" "$stage/app/"
  cp -R "$app_source/forma" "$stage/app/"
else
  echo 'Downloading Folio Desk…'
  curl --fail --show-error --silent --location --retry 3 \
    https://codeload.github.com/huacnlee/folio-mail/tar.gz/refs/heads/main -o "$stage/mail.tar.gz"
  mkdir "$stage/source"
  tar -xzf "$stage/mail.tar.gz" -C "$stage/source" --strip-components=1
  for file in main.js mailbox.js theme.js gpui-shell.json; do
    cp "$stage/source/$file" "$stage/app/"
  done
  cp -R "$stage/source/forma" "$stage/app/"
fi

if [ -n "$app_source" ] && [ -f "$app_source/LICENSE" ]; then
  cp "$app_source/LICENSE" "$stage/app/"
elif [ -f "$stage/source/LICENSE" ]; then
  cp "$stage/source/LICENSE" "$stage/app/"
fi

# Validate before replacing an installed copy. The manifest id keeps local data.
"$shell_path" check -d "$stage/app"
if [ -L "$app_dir" ]; then
  echo "Refusing to replace the linked application: $app_dir" >&2
  exit 1
fi
if [ -e "$app_dir" ]; then
  mv "$app_dir" "$stage/previous"
fi
if ! mv "$stage/app" "$app_dir"; then
  [ ! -e "$stage/previous" ] || mv "$stage/previous" "$app_dir"
  exit 1
fi

# The URI is validated and never interpolated into a command.
cat > "$stage/folio-mail" <<'LAUNCHER'
#!/bin/sh
set -eu
case "${1:-}" in
  '' | 'folio-mail://open' | 'folio-mail://open/') ;;
  *) echo 'Supported launch link: folio-mail://open' >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo 'Unexpected launch arguments' >&2; exit 2; }
exec ~/.local/bin/gpui-shell run -d ~/.gpui-shell/apps/folio-mail
LAUNCHER
install -m 755 "$stage/folio-mail" "$bin_dir/folio-mail"

if [ "$system" = linux ]; then
  desktop_dir=~/.local/share/applications
  mkdir -p "$desktop_dir"
  # Desktop Exec quoting has its own grammar; escape account paths literally.
  desktop_exec=$(printf '%s' "$bin_dir/folio-mail" | sed 's/\\/\\\\/g; s/"/\\"/g; s/`/\\`/g; s/\$/\\$/g; s/%/%%/g')
  cat > "$stage/folio-mail.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Folio Desk
Comment=A quieter place for your correspondence
Exec="$desktop_exec" %u
Icon=mail-message-new
Terminal=false
Categories=Office;Email;
MimeType=x-scheme-handler/folio-mail;
StartupNotify=true
DESKTOP
  install -m 644 "$stage/folio-mail.desktop" "$desktop_dir/folio-mail.desktop"
  if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$desktop_dir"; fi
  xdg-mime default folio-mail.desktop x-scheme-handler/folio-mail
else
  # A native AppleScript application receives open-location Apple Events.
  applications_dir=~/Applications
  mkdir -p "$applications_dir"
  applescript_path=$(printf '%s' "$bin_dir/folio-mail" | sed 's/\\/\\\\/g; s/"/\\"/g')
  cat > "$stage/launch.applescript" <<APPLESCRIPT
on run
  do shell script "nohup " & quoted form of "$applescript_path" & " >/dev/null 2>&1 &"
end run
on open location address
  if address is "folio-mail://open" or address is "folio-mail://open/" then
    run
  end if
end open location
APPLESCRIPT
  osacompile -o "$stage/Folio Desk.app" "$stage/launch.applescript"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string com.folio.mail.launcher' "$stage/Folio Desk.app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes array' "$stage/Folio Desk.app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0 dict' "$stage/Folio Desk.app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLName string Folio Desk' "$stage/Folio Desk.app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array' "$stage/Folio Desk.app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string folio-mail' "$stage/Folio Desk.app/Contents/Info.plist"
  # Only replace the launcher bundle created by this installer.
  if [ -e "$applications_dir/Folio Desk.app" ]; then
    bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$applications_dir/Folio Desk.app/Contents/Info.plist")
    [ "$bundle_id" = com.folio.mail.launcher ] || { echo 'An unrelated Folio Desk.app already exists.' >&2; exit 1; }
    mv "$applications_dir/Folio Desk.app" "$stage/previous-launcher.app"
  fi
  mv "$stage/Folio Desk.app" "$applications_dir/Folio Desk.app"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$applications_dir/Folio Desk.app"
fi

echo ''
echo 'Folio Desk installed.'
echo 'Launch link: folio-mail://open'
echo 'Terminal: ~/.local/bin/folio-mail'
echo 'Or choose Folio Desk from your application launcher.'
if [ "$launch" = true ]; then
  nohup "$bin_dir/folio-mail" >/dev/null 2>&1 &
fi
