#!/usr/bin/env bash
# Puts the Apple Distribution certificate into a keychain made for this run
# and checks it, for the iOS workflow on a macOS runner. Reads IOS_DIST_P12
# (the .p12, base64), IOS_DIST_P12_PASSWORD and APPLE_TEAM_ID.
#
#   bash scripts/signing-keychain.sh
#
# Writes to $GITHUB_OUTPUT: keychain (its path), sha1 (the identity's hash,
# for ExportOptions), expires, and renew=yes when the certificate ends
# within 30 days. Leaves the certificate, without its key, at
# $RUNNER_TEMP/dist.pem for the profile lookup.
#
# Workflow logs can be read by others, and the certificate's name holds the
# Account Holder's legal name, so it and the team ID are masked before
# anything could print them, and nothing here echoes them.

set -euo pipefail

: "${IOS_DIST_P12:?}" "${IOS_DIST_P12_PASSWORD:?}" "${APPLE_TEAM_ID:?}" "${RUNNER_TEMP:?}"
echo "::add-mask::$APPLE_TEAM_ID"

keychain="$RUNNER_TEMP/tiptop-signing.keychain-db"
password=$(openssl rand -hex 24)
echo "::add-mask::$password"
security delete-keychain "$keychain" > /dev/null 2>&1 || true
security create-keychain -p "$password" "$keychain"
# Stays unlocked for six hours, longer than any job runs.
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"

p12="$RUNNER_TEMP/dist.p12"
# Accepts the base64 with or without line breaks.
node -e 'process.stdout.write(Buffer.from(process.env.IOS_DIST_P12.replace(/\s+/g, ""), "base64"))' > "$p12"
if ! security import "$p12" -k "$keychain" -f pkcs12 -P "$IOS_DIST_P12_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security > /dev/null 2>&1; then
  rm -f "$p12"
  echo "::error::IOS_DIST_P12 could not be imported: check the secret is the base64 of the .p12 and IOS_DIST_P12_PASSWORD is its password."
  exit 1
fi
rm -f "$p12"
# Lets codesign use the key without asking, which no one could answer on a
# runner (codesign fails with errSecInternalComponent otherwise).
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" > /dev/null
# Searched first, ahead of the runner's own keychains.
existing=$(security list-keychains -d user | tr -d '"')
# shellcheck disable=SC2086
security list-keychains -d user -s "$keychain" $existing

identities=$(security find-identity -v -p codesigning "$keychain")
name=$(printf '%s\n' "$identities" | sed -n 's/.*"\(Apple Distribution: [^"]*\)".*/\1/p' | head -n 1)
if [ -z "$name" ]; then
  echo "::error::IOS_DIST_P12 holds no Apple Distribution identity (the certificate together with its private key)."
  exit 1
fi
echo "::add-mask::$name"
echo "::add-mask::${name#Apple Distribution: }"
sha1=$(printf '%s\n' "$identities" | grep -F "\"$name\"" | awk '{print $2}' | head -n 1)

pem="$RUNNER_TEMP/dist.pem"
security find-certificate -c "$name" -p "$keychain" > "$pem"
team=$(openssl x509 -in "$pem" -noout -subject | sed -nE 's/.*OU ?= ?([A-Z0-9]{10}).*/\1/p')
if [ "$team" != "$APPLE_TEAM_ID" ]; then
  echo "::error::The certificate in IOS_DIST_P12 belongs to a different team than the APPLE_TEAM_ID variable."
  exit 1
fi
expires=$(openssl x509 -in "$pem" -noout -enddate | cut -d= -f2)
if ! openssl x509 -in "$pem" -noout -checkend 0 > /dev/null; then
  echo "::error::The Apple Distribution certificate expired on $expires. Make a new one: see \"Renewing the certificate\" in ios-app/README.md."
  exit 1
fi
renew=no
if ! openssl x509 -in "$pem" -noout -checkend $((30 * 86400)) > /dev/null; then
  renew=yes
  echo "::warning::The Apple Distribution certificate expires on $expires. Renew it before then: see \"Renewing the certificate\" in ios-app/README.md."
fi

{
  echo "keychain=$keychain"
  echo "sha1=$sha1"
  echo "expires=$expires"
  echo "renew=$renew"
} >> "$GITHUB_OUTPUT"
echo "The Apple Distribution certificate is ready, valid until $expires."
