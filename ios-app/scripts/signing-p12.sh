#!/usr/bin/env bash
# Step two of making the signing certificates, run by the admin once the
# Account Holder has sent back the certificates Apple issued for the requests
# from signing-request.sh. Joins each certificate to its private key in a
# password-protected .p12, and writes the values to paste into GitHub.
#
#   bash ios-app/scripts/signing-p12.sh <the same folder>
#
# Put Apple's downloads in the folder first, named dist.cer (Apple
# Distribution) and, when the Mac app's turn comes, devid.cer (Developer ID
# Application). It makes dist.p12 and devid.p12 next to them, each with a new
# random password, and paste-into-github.txt with every value. Nothing is
# printed: open that file, paste each value into GitHub (ios-app/README.md
# says where), keep the .p12 files and passwords in the password manager,
# then delete the .txt file.
#
# The .p12 files use the long-standing PKCS#12 encryption (3DES, SHA-1 MAC)
# that every macOS `security import` reads, rather than OpenSSL 3's newer
# default.

set -euo pipefail

folder=${1:?Pass the folder that holds the keys and the .cer files}
cd "$folder"
umask 077

out=paste-into-github.txt
: > "$out"
made=0

for name in dist devid; do
  [ -f "$name.cer" ] || continue
  if [ ! -f "$name.key" ]; then
    echo "$name.cer is here but $name.key is not: this certificate was made for another key." >&2
    exit 1
  fi
  # Apple's download is DER; accept PEM too.
  if ! openssl x509 -inform DER -in "$name.cer" -out "$name.pem" 2> /dev/null; then
    openssl x509 -in "$name.cer" -out "$name.pem"
  fi
  if [ "$(openssl x509 -in "$name.pem" -noout -pubkey)" != "$(openssl pkey -in "$name.key" -pubout)" ]; then
    echo "$name.cer does not belong to $name.key. Ask for a certificate made from $name.certSigningRequest." >&2
    exit 1
  fi
  subject=$(openssl x509 -in "$name.pem" -noout -subject)
  team=$(printf '%s\n' "$subject" | sed -nE 's/.*OU ?= ?([A-Z0-9]{10}).*/\1/p')
  case "$name" in
    dist) expect='Apple Distribution: ' ; secret=IOS_DIST_P12 ;;
    devid) expect='Developer ID Application: ' ; secret=MAC_DEVID_P12 ;;
  esac
  if ! printf '%s\n' "$subject" | grep -Fq "$expect"; then
    echo "$name.cer is not an \"${expect%: }\" certificate. Check which certificate type was chosen at developer.apple.com." >&2
    exit 1
  fi

  P12_PASSWORD=$(openssl rand -hex 16)
  export P12_PASSWORD
  openssl pkcs12 -export -inkey "$name.key" -in "$name.pem" -out "$name.p12" \
    -passout env:P12_PASSWORD -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
  # Reads it back the way it will be read, to be sure the password opens it.
  openssl pkcs12 -in "$name.p12" -passin env:P12_PASSWORD -noout

  {
    echo "Secret $secret:"
    openssl base64 -A -in "$name.p12"
    echo
    echo
    echo "Secret ${secret}_PASSWORD:"
    echo "$P12_PASSWORD"
    echo
  } >> "$out"
  unset P12_PASSWORD
  if [ "$name" = dist ]; then
    {
      echo "Variable APPLE_TEAM_ID (from the certificate):"
      echo "$team"
      echo
    } >> "$out"
  fi
  echo "Made $folder/$name.p12 ($(openssl x509 -in "$name.pem" -noout -enddate | sed 's/notAfter=/valid until /'))."
  made=$((made + 1))
done

if [ "$made" -eq 0 ]; then
  rm -f "$out"
  echo "No dist.cer or devid.cer in $folder yet." >&2
  exit 1
fi
echo
echo "The values to paste are in $folder/$out. Delete that file once they are in GitHub."
