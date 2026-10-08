// Stage the complete native payload from the exact release this fork starts from.
// JavaScript-only iteration does not require installing the Rust/FFmpeg toolchain.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = "v2.0.0";
const assets = {
	arm64: {
		name: "Openscreen-Mac-arm64-2.0.0.zip",
		sha256: "f257d63c55d229d4e8eb0511e546b7c8e16b80cc4d47b835df8396b75736db51",
	},
	x64: {
		name: "Openscreen-Mac-x64-2.0.0.zip",
		sha256: "687128c3118ddde8fdd41c6c1d5648f1a146eb81f649fde58ac09c80ec0cbecb",
	},
};
if (process.platform !== "darwin" || !assets[process.arch])
	throw new Error("This setup is for macOS arm64 or x64.");
const asset = assets[process.arch];
const changed = execFileSync(
	"git",
	["diff", "--name-only", version, "--", "crates", "electron/native"],
	{ cwd: root, encoding: "utf8" },
).trim();
const untracked = execFileSync(
	"git",
	["ls-files", "--others", "--exclude-standard", "--", "crates", "electron/native"],
	{ cwd: root, encoding: "utf8" },
).trim();
if (changed || untracked)
	throw new Error(
		"Native sources differ from v2.0.0. Build native helpers from source instead of staging release binaries.",
	);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "product-intel-native-"));
try {
	const archive = path.join(temp, asset.name);
	if (process.argv[2]) await fs.copyFile(path.resolve(process.argv[2]), archive);
	else
		execFileSync(
			"gh",
			[
				"release",
				"download",
				version,
				"--repo",
				"getopenscreen/openscreen",
				"--pattern",
				asset.name,
				"--dir",
				temp,
			],
			{ stdio: "inherit" },
		);
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(archive)) hash.update(chunk);
	if (hash.digest("hex") !== asset.sha256) throw new Error("Release archive checksum mismatch.");
	execFileSync("ditto", ["-x", "-k", archive, temp]);
	const source = path.join(
		temp,
		"Openscreen.app/Contents/Resources/electron/native/bin",
		`darwin-${process.arch}`,
	);
	const target = path.join(root, "electron/native/bin", `darwin-${process.arch}`);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.cp(source, target, { recursive: true, preserveTimestamps: false });
	await fs.writeFile(
		path.join(target, "product-intel-provenance.json"),
		JSON.stringify(
			{
				repository: "getopenscreen/openscreen",
				version,
				asset: asset.name,
				sha256: asset.sha256,
				stagedAt: new Date().toISOString(),
			},
			null,
			2,
		),
	);
	console.log(`Verified and staged ${version} native payload for ${process.arch}.`);
} finally {
	await fs.rm(temp, { recursive: true, force: true });
}
