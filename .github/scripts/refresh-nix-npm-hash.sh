#!/usr/bin/env bash
# Rewrites `npmDepsHash` in nix/package.nix for the package-lock.json in the working tree.
#
# Called by prerelease.yml and promote.yml right after set-release-version.mjs, in the same
# commit. The lockfile's root `version` is part of what the hash covers, so every version bump
# changes it; that commit is `[skip ci]`, and refreshing the hash anywhere later left `nix build`
# red from the release until a separate bump PR landed. Needs Nix on PATH.
set -euo pipefail

hash=$(nix run nixpkgs#prefetch-npm-deps -- package-lock.json)
if [[ -z "$hash" ]]; then
	echo "::error::prefetch-npm-deps returned an empty hash"
	exit 1
fi
sed -i -E "s|^([[:space:]]*npmDepsHash[[:space:]]*=[[:space:]]*)\"[^\"]*\";|\1\"${hash}\";|" nix/package.nix
grep -q "npmDepsHash = \"${hash}\";" nix/package.nix || {
	echo "::error::npmDepsHash line not found in nix/package.nix"
	exit 1
}
echo "npmDepsHash: ${hash}"
