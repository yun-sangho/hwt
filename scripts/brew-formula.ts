// Print the Homebrew formula for a published release: bun scripts/brew-formula.ts 0.1.0 > Formula/hwt.rb
// It downloads the release's binaries (gh release download) to compute their sha256.
import { $ } from "bun";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = process.argv[2]?.replace(/^v/, "");
if (!version) {
  console.error("usage: bun scripts/brew-formula.ts <version>");
  process.exit(2);
}
const repo = "yun-sangho/hwt";
const dir = mkdtempSync(join(tmpdir(), "hwt-formula-"));
await $`gh release download v${version} -R ${repo} -p ${"hwt-*"} -D ${dir}`.quiet();

const sha = (name: string) => new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, name))).digest("hex");
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
      Check your setup:

        hwt doctor

      Optional shell wrapper (leaves you in the main checkout after \`hwt rm\`):

        eval "$(hwt shell-init zsh)"    # in ~/.zshrc (or bash / fish)
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/hwt --version").strip
    assert_match "usage", shell_output("#{bin}/hwt task add --help")
  end
end
`);
