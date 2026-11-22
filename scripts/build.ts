// Build single-file executables: bun scripts/build.ts [--all]
// Default: this machine only → dist/hwt. --all: every release target → dist/hwt-<os>-<arch>.
import { $ } from "bun";

const targets = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64"];
const all = process.argv.includes("--all");

await $`mkdir -p dist`;
if (!all) {
  await $`bun build --compile --minify src/cli.ts --outfile dist/hwt`;
  console.log("dist/hwt");
} else {
  for (const t of targets) {
    const out = `dist/hwt-${t.replace(/^bun-/, "")}`;
    await $`bun build --compile --minify --target=${t} src/cli.ts --outfile ${out}`;
    console.log(out);
  }
}
