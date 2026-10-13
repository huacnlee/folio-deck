#!/bin/sh
# curl -fsSL https://raw.githubusercontent.com/huacnlee/folio-deck/main/install.sh | sh
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
for utility in curl tar install mktemp node; do
  command -v "$utility" >/dev/null 2>&1 || { echo "Missing dependency: $utility" >&2; exit 1; }
done
if [ "$system" = linux ]; then
  command -v xdg-mime >/dev/null 2>&1 || { echo 'Install xdg-utils for the launch link.' >&2; exit 1; }
else
  for utility in osacompile codesign iconutil; do
    command -v "$utility" >/dev/null 2>&1 || { echo "Missing macOS $utility." >&2; exit 1; }
  done
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) { console.error("Gmail authorization requires Node.js 20 or newer."); process.exit(1); }'

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
  cp "$app_source/main.js" "$app_source/mailbox.js" "$app_source/theme.js" "$app_source/gmail.js" "$app_source/gmail-view.js" "$app_source/avatar.js" "$app_source/oauth-callback.js" "$app_source/oauth-runtime.js" "$app_source/gpui-shell.json" "$stage/app/"
  cp -R "$app_source/forma" "$stage/app/"
else
  echo 'Downloading Folio Desk…'
  curl --fail --show-error --silent --location --retry 3 \
    https://codeload.github.com/huacnlee/folio-deck/tar.gz/refs/heads/main -o "$stage/mail.tar.gz"
  mkdir "$stage/source"
  tar -xzf "$stage/mail.tar.gz" -C "$stage/source" --strip-components=1
  for file in main.js mailbox.js theme.js gmail.js gmail-view.js avatar.js oauth-callback.js oauth-runtime.js gpui-shell.json; do
    cp "$stage/source/$file" "$stage/app/"
  done
  cp -R "$stage/source/forma" "$stage/app/"
fi

# Finder does not inherit a terminal's Node search path. Record the verified
# system executable and grant that exact command, without modifying PATH.
node - "$stage/app" <<'NODE'
const fs = require('node:fs');
const app = process.argv[2];
const executable = process.execPath;
fs.writeFileSync(app + '/oauth-runtime.js', 'export const nodeCommand = ' + JSON.stringify(executable) + ';\n');
const manifest = JSON.parse(fs.readFileSync(app + '/gpui-shell.json', 'utf8'));
manifest.capabilities.fs.execute = [executable];
fs.writeFileSync(app + '/gpui-shell.json', JSON.stringify(manifest, null, 2) + '\n');
NODE

if [ -n "$app_source" ] && [ -f "$app_source/LICENSE" ]; then
  cp "$app_source/LICENSE" "$stage/app/"
elif [ -f "$stage/source/LICENSE" ]; then
  cp "$stage/source/LICENSE" "$stage/app/"
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
LAUNCHER

if [ "$system" = linux ]; then
  # Validate before replacing an installed copy. Keep its stable data location.
  "$shell_path" check -d "$stage/app"
  if [ -L "$app_dir" ]; then
    echo "Refusing to replace the linked application: $app_dir" >&2
    exit 1
  fi
  if [ -e "$app_dir" ]; then mv "$app_dir" "$stage/previous"; fi
  if ! mv "$stage/app" "$app_dir"; then
    [ ! -e "$stage/previous" ] || mv "$stage/previous" "$app_dir"
    exit 1
  fi
  echo 'exec ~/.local/bin/gpui-shell run -d ~/.gpui-shell/apps/folio-mail' >> "$stage/folio-mail"
  install -m 755 "$stage/folio-mail" "$bin_dir/folio-mail"
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
  # Package both the runtime and app. The AppleScript executable only handles
  # Finder/URL events; it resolves the bundled runtime relative to the .app.
  applications_dir=~/Applications
  bundle="$stage/Folio Desk.app"
  mkdir -p "$applications_dir"
  cat > "$stage/launch.applescript" <<'APPLESCRIPT'
on launchFolio()
  set bundlePath to POSIX path of (path to me)
  set runtimePath to bundlePath & "Contents/MacOS/gpui-shell"
  set appPath to bundlePath & "Contents/Resources/app"
  do shell script "nohup " & quoted form of runtimePath & " run -d " & quoted form of appPath & " >/dev/null 2>&1 &"
end launchFolio
on run
  launchFolio()
end run
on open location address
  if address is "folio-mail://open" or address is "folio-mail://open/" then
    launchFolio()
  end if
end open location
APPLESCRIPT
  osacompile -o "$bundle" "$stage/launch.applescript"
  mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
  install -m 755 "$shell_path" "$bundle/Contents/MacOS/gpui-shell"
  cp -R "$stage/app" "$bundle/Contents/Resources/app"
  iconutil -c icns "$stage/app/forma/assets/FolioDesk.iconset" -o "$bundle/Contents/Resources/FolioDesk.icns"
  # The compiled AppleScript asset catalog can override CFBundleIconFile.
  # Remove its default icon catalog from this staged bundle before signing.
  if [ -f "$bundle/Contents/Resources/Assets.car" ]; then
    mv "$bundle/Contents/Resources/Assets.car" "$stage/applescript-assets.car"
  fi
  plist="$bundle/Contents/Info.plist"
  # osacompile already supplies some keys. Set first, then Add if absent.
  # Unconditional Add used to abort here when CFBundleIdentifier existed.
  plist_set() {
    /usr/libexec/PlistBuddy -c "Set :$1 $3" "$plist" 2>/dev/null ||
      /usr/libexec/PlistBuddy -c "Add :$1 $2 $3" "$plist"
  }
  plist_set CFBundleIdentifier string com.folio.desk
  plist_set CFBundleName string 'Folio Desk'
  plist_set CFBundleDisplayName string 'Folio Desk'
  /usr/libexec/PlistBuddy -c 'Delete :CFBundleIconName' "$plist" 2>/dev/null || true
  plist_set CFBundleIconFile string FolioDesk.icns
  plist_set CFBundleShortVersionString string 0.1.0
  plist_set CFBundleVersion string 2
  plist_set LSApplicationCategoryType string public.app-category.productivity
  /usr/libexec/PlistBuddy -c 'Delete :CFBundleURLTypes' "$plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes array' "$plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0 dict' "$plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleTypeRole string Viewer' "$plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLName string Folio Desk' "$plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array' "$plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string folio-mail' "$plist"
  # check generates declarations/editor config inside the app. Finish those
  # writes before sealing the resources with the bundle signature.
  "$bundle/Contents/MacOS/gpui-shell" check -d "$bundle/Contents/Resources/app"
  codesign --force --deep --sign - "$bundle"
  codesign --verify --deep --strict "$bundle"
  destination="$applications_dir/Folio Desk.app"
  if [ -L "$destination" ]; then
    echo "Refusing to replace the linked application: $destination" >&2
    exit 1
  fi
  if [ -e "$destination" ]; then
    bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$destination/Contents/Info.plist")
    case "$bundle_id" in
      com.folio.desk | com.folio.mail.launcher) ;;
      *) echo 'An unrelated Folio Desk.app already exists.' >&2; exit 1 ;;
    esac
    mv "$destination" "$stage/previous-bundle.app"
  fi
  if ! mv "$bundle" "$destination"; then
    [ ! -e "$stage/previous-bundle.app" ] || mv "$stage/previous-bundle.app" "$destination"
    exit 1
  fi
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$destination"
  echo 'exec /usr/bin/open ~/Applications/"Folio Desk.app"' >> "$stage/folio-mail"
  install -m 755 "$stage/folio-mail" "$bin_dir/folio-mail"
  echo "Application: $destination"

fi

echo ''
echo 'Folio Desk installed.'
echo 'Launch link: folio-mail://open'
echo 'Terminal: ~/.local/bin/folio-mail'
echo 'Or choose Folio Desk from your application launcher.'
if [ "$launch" = true ]; then
  nohup "$bin_dir/folio-mail" >/dev/null 2>&1 &
fi
