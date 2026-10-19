#!/usr/bin/env bash
# Step one of making the signing certificates, run once by the admin on
# their own computer (Git Bash on Windows is fine). Makes two private keys and
# the two certificate signing requests the Account Holder uploads at
# developer.apple.com. The keys never leave the folder; the requests are not
# secret.
#
#   bash ios-app/scripts/signing-request.sh <folder outside the repository> <your work email>
#
# Writes into the folder (made if needed):
#   dist.key   and dist.certSigningRequest    Apple Distribution: signs the iPhone app
#   devid.key  and devid.certSigningRequest   Developer ID Application: signs the Mac app
#                                             (used later, made now so the Account
#                                             Holder uploads both in one sitting)
# Refuses a folder inside a git checkout, and never overwrites a key.
# Step two, once Apple's .cer files are in the folder: signing-p12.sh.

set -euo pipefail

folder=${1:?Pass a folder outside the repository, for example /e/tiptop-apple-signing}
email=${2:?Pass your work email (it goes into the requests only)}

# Checked on the nearest folder that exists, before anything is made.
probe=$folder
while [ ! -d "$probe" ]; do probe=$(dirname "$probe"); done
if git -C "$probe" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "That folder is inside a git checkout. Choose one outside any repository." >&2
  exit 1
fi
umask 077
mkdir -p "$folder"
cd "$folder"

for name in dist devid; do
  if [ -e "$name.key" ]; then
    echo "$folder/$name.key already exists; leaving it and its request as they are."
    continue
  fi
  case "$name" in
    dist) label='TipTop Copilot iPhone distribution' ;;
    devid) label='TipTop Copilot Mac Developer ID' ;;
  esac
  openssl genrsa -out "$name.key" 2048 2> /dev/null
  # MSYS_NO_PATHCONV stops Git Bash rewriting the leading "/" of -subj as a
  # Windows path.
  MSYS_NO_PATHCONV=1 openssl req -new -key "$name.key" -out "$name.certSigningRequest" \
    -subj "/emailAddress=$email/CN=$label/C=US"
  echo "Made $folder/$name.certSigningRequest"
done

echo
echo "Send the two .certSigningRequest files to the Account Holder. Keep the .key files"
echo "here: they never leave this folder, and nothing else can open the certificates."
