import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, chmod, rm } from "node:fs/promises";
import path from "node:path";

// Official release asset checksums, pinned together with the compiler version.
const assets = {
  "linux-x64": ["x86_64-unknown-linux-musl", "8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7"],
  "linux-arm64": ["aarch64-unknown-linux-musl", "b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8"],
  "darwin-arm64": ["aarch64-apple-darwin", "a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667"],
  "darwin-x64": ["x86_64-apple-darwin", "7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80"],
};
const asset = assets[`${process.platform}-${process.arch}`];
if (!asset) throw new Error("No pinned Tectonic binary for this platform.");
const root = path.resolve(process.argv[2] || ".data/latex-runtime");
await mkdir(path.join(root, "cache"), { recursive: true });
const response = await fetch(`https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-${asset[0]}.tar.gz`, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`Tectonic download failed (${response.status}).`);
const archive = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(archive).digest("hex") !== asset[1]) throw new Error("Tectonic release checksum mismatch.");
const archivePath = path.join(root, "compiler.tar.gz");
await writeFile(archivePath, archive);
execFileSync("tar", ["-xzf", archivePath, "-C", root, "tectonic"]);
await chmod(path.join(root, "tectonic"), 0o755);
await rm(archivePath);
// Warm every package/font/style used by the application. Production runs use
// --only-cached, so a cold runtime never performs network package downloads.
const fixture = String.raw`\documentclass[11pt,letterpaper]{article}
\usepackage[margin=0.55in]{geometry}
\usepackage{fontspec}
\setmainfont{texgyretermes}[Extension=.otf,UprightFont=*-regular,BoldFont=*-bold,ItalicFont=*-italic,BoldItalicFont=*-bolditalic]
\usepackage{enumitem,titlesec}
\usepackage[hidelinks,unicode]{hyperref}
\usepackage{xurl}
\urlstyle{same}
\begin{document}
Regular \textbf{Bold} \textit{Italic} \textbf{\textit{Bold italic}}
\section*{Experience}
\begin{itemize}\item A verified achievement.\end{itemize}
\href{https://example.com/profile}{\nolinkurl{https://example.com/profile}}
\end{document}`;
const warm = path.join(root, "warm");
await mkdir(warm, { recursive: true });
await writeFile(path.join(warm, "warm.tex"), fixture);
execFileSync(path.join(root, "tectonic"), ["-X", "compile", "--untrusted", "--outdir", warm, path.join(warm, "warm.tex")], { env: { PATH: process.env.PATH, HOME: warm, TECTONIC_CACHE_DIR: path.join(root, "cache"), SOURCE_DATE_EPOCH: "946684800" }, stdio: "inherit", timeout: 240_000 });
await rm(warm, { recursive: true });
console.log(`Pinned LaTeX runtime and cache ready at ${root}`);
