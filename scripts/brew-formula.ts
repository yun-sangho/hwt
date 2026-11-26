// Print the Homebrew formula for a release: bun scripts/brew-formula.ts <version> [--from <dir>] > Formula/hwt.rb
// sha256s come from the binaries in <dir> (the release job's dist/, just built), else from the published
// release (gh release download).
import { $ } from "bun";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const fromAt = args.indexOf("--from");
const from = fromAt >= 0 ? args[fromAt + 1] : undefined;
const version = args.find((a, i) => !a.startsWith("--") && i !== fromAt + 1)?.replace(/^v/, "");
if (!version || (fromAt >= 0 && !from)) {
  console.error("usage: bun scripts/brew-formula.ts <version> [--from <dir>]");
  process.exit(2);
}
const repo = "yun-sangho/hwt";
let dir = from;
if (!dir) {
  dir = mkdtempSync(join(tmpdir(), "hwt-formula-"));
  await $`gh release download v${version} -R ${repo} -p ${"hwt-*"} -D ${dir}`.quiet();
}

const sha = (name: string) => new Bun.CryptoHasher("sha256").update(readFileSync(join(dir!, name))).digest("hex");
const url = (name: string) => `https://github.com/${repo}/releases/download/v${version}/${name}`;
const asset = (os: string, arch: string) => {
  const name = `hwt-${os}-${arch}`;
  return `      url "${url(name)}"\n      sha256 "${sha(name)}"`;
};

process.stdout.write(`class Hwt < Formula
  desc "Git worktrees as Herdr spaces, with a ledger for parallel coding agents"
  homepage "https://github.com/${repo}"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
${asset("darwin", "arm64")}
    end
    on_intel do
${asset("darwin", "x64")}
    end
  end

  on_linux do
    on_arm do
${asset("linux", "arm64")}
    end
    on_intel do
${asset("linux", "x64")}
    end
  end

  def install
    bin.install Dir["hwt-*"].first => "hwt"
  end

  def caveats
    <<~EOS
      hwt needs the Herdr app (herdr-app and hc) running for \`hwt new\`.
      Give your agents the hwt skill and session-start wiring, then check:

        hwt install all --lang en    # or ko; claude | codex | all
        hwt doctor
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/hwt --version").strip
    assert_match "usage", shell_output("#{bin}/hwt task add --help")
  end
end
`);
