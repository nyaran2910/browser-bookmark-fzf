import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { Bookmark } from "./browser";

const resultLimit = 100;

export async function findFzf(preference?: string) {
  const explicit = preference?.trim().replace(/^~\//, `${homedir()}/`);
  const folders = [
    ...(process.env.PATH ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".nix-profile/bin"),
    `/etc/profiles/per-user/${process.env.USER ?? ""}/bin`,
    "/run/current-system/sw/bin",
  ];
  const paths = explicit ? [explicit] : folders.filter(isAbsolute).map((folder) => join(folder, "fzf"));

  for (const path of new Set(paths)) {
    if (!isAbsolute(path)) break;
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Continue through the known installation paths.
    }
  }
  throw new Error(explicit
    ? "Set FZF Executable to an absolute path to an executable fzf binary."
    : "fzf was not found. Install it or set FZF Executable in extension settings.");
}

export function searchBookmarks(bookmarks: Bookmark[], query: string, executable: string, signal: AbortSignal) {
  if (!query.trim() || !bookmarks.length) return Promise.resolve(bookmarks.slice(0, resultLimit));
  const rows = bookmarks.map(({ kind, title, folder, url, profileName, read }, i) => {
    const status = kind === "reading-list" ? (read ? "read" : "unread") : "";
    const fields = [title, url, folder, status, profileName].filter(Boolean);
    return `${i}\t${fields.join(" ").replace(/[\0\t\r\n]/g, " ")}\0`;
  });
  const env = { ...process.env };
  delete env.FZF_DEFAULT_OPTS;
  delete env.FZF_DEFAULT_OPTS_FILE;

  return new Promise<Bookmark[]>((resolve, reject) => {
    const args = ["--read0", "--print0", "--delimiter=\t", "--nth=2..", `--filter=${query}`];
    const child = execFile(executable, args, { env, signal, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error.code !== 1 || stderr.trim())) {
        reject(new Error(stderr.trim() || `fzf failed (${error.code ?? error.name}).`));
        return;
      }
      const matches = stdout.split("\0").filter(Boolean).slice(0, resultLimit);
      resolve(matches.map((row) => bookmarks[Number(row.slice(0, row.indexOf("\t")))]));
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(rows.join(""));
  });
}
