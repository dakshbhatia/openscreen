// Run with Node 22: node scripts/generate-product-intel-icons.mjs
// public/product-intel.svg is the source. macOS iconutil also regenerates the ICNS.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "build/product-intel");
const source = await readFile(path.join(root, "public/product-intel.svg"));
await mkdir(path.join(output, "png"), { recursive: true });
await writeFile(path.join(root, "src/assets/product-intel-mark.svg"), source);

const pngs = new Map();
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
	const png = await sharp(source, { density: 1536 }).resize(size, size).png().toBuffer();
	pngs.set(size, png);
	await writeFile(path.join(output, "png", `${size}x${size}.png`), png);
}

function pngAt(size) {
	const png = pngs.get(size);
	if (!png) throw new Error(`Missing generated PNG at ${size}px`);
	return png;
}

await writeFile(path.join(root, "public/product-intel.png"), pngAt(512));

// Modern Windows ICO containers support PNG entries, including 256px at scale.
const sizes = [16, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
const parts = [header];
let offset = header.length;
for (const [index, size] of sizes.entries()) {
	const png = pngAt(size);
	const entry = 6 + index * 16;
	header[entry] = size === 256 ? 0 : size;
	header[entry + 1] = size === 256 ? 0 : size;
	header.writeUInt16LE(1, entry + 4);
	header.writeUInt16LE(32, entry + 6);
	header.writeUInt32LE(png.length, entry + 8);
	header.writeUInt32LE(offset, entry + 12);
	parts.push(png);
	offset += png.length;
}
await writeFile(path.join(output, "icon.ico"), Buffer.concat(parts));

const iconutil = "/usr/bin/iconutil";
if (existsSync(iconutil)) {
	const temporary = await mkdtemp(path.join(tmpdir(), "product-intel-icons-"));
	const iconset = path.join(temporary, "ProductIntel.iconset");
	try {
		await mkdir(iconset);
		for (const size of [16, 32, 128, 256, 512]) {
			await writeFile(path.join(iconset, `icon_${size}x${size}.png`), pngAt(size));
			await writeFile(path.join(iconset, `icon_${size}x${size}@2x.png`), pngAt(size * 2));
		}
		execFileSync(iconutil, ["-c", "icns", "-o", path.join(output, "icon.icns"), iconset]);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
} else {
	console.log("ICNS unchanged: regenerate on macOS with iconutil installed.");
}
console.log("Product Intel SVG copies, PNGs, and ICO regenerated.");
