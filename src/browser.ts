import { execFile, spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readProfileReadingList } from "./reading-list.ts";

const run = promisify(execFile);
const detectBrowser = `
ObjC.import("AppKit");
const workspace = $.NSWorkspace.sharedWorkspace;
const url = workspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com"));
const app = $.NSBundle.bundleWithURL(url);
JSON.stringify([ObjC.unwrap(app.bundleIdentifier), ObjC.unwrap(app.executablePath)]);
`;

const browsers = {
  "com.brave.Browser": { name: "Brave", folder: "BraveSoftware/Brave-Browser" },
  "com.google.Chrome": { name: "Chrome", folder: "Google/Chrome" },
};

export async function defaultBrowser(signal: AbortSignal) {
  const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", detectBrowser], { signal });
  const [id, executable] = JSON.parse(stdout) as [string | null, string | null];
  const browser = id && Object.hasOwn(browsers, id) ? browsers[id as keyof typeof browsers] : undefined;
  if (!browser || !executable) throw new Error("Set Brave or Google Chrome as the macOS default browser.");
  return { ...browser, executable };
}

export type BrowserItemKind = "bookmark" | "reading-list";

export interface Bookmark {
  kind: BrowserItemKind;
  title: string;
  url: string;
  folder: string;
  profile: string;
  profileName: string;
  read?: boolean;
}

interface BookmarkNode {
  name?: string;
  type?: string;
  url?: string;
  children?: BookmarkNode[];
}

export class BrowserDataAccessError extends Error {
  constructor(cause: unknown) {
    super("Under Files & Folders → Raycast, enable access for your default browser. Then use Reload.", { cause });
    this.name = "BrowserDataAccessError";
  }
}

function collectBookmarks(
  nodes: BookmarkNode[],
  folder: string,
  profile: string,
  profileName: string,
  results: Bookmark[],
) {
  for (const node of nodes) {
    if (node.type === "folder" && Array.isArray(node.children)) {
      const path = [folder, node.name].filter(Boolean).join(" / ");
      collectBookmarks(node.children, path, profile, profileName, results);
    } else if (node.type === "url" && node.url && /^https?:\/\//i.test(node.url)) {
      results.push({
        kind: "bookmark",
        title: node.name?.trim() || node.url,
        url: node.url,
        folder,
        profile,
        profileName,
      });
    }
  }
}

async function readOptional(path: string, signal: AbortSignal) {
  try {
    return await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function readBookmarks(root: string, signal: AbortSignal) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const state = await readOptional(join(root, "Local State"), signal);
    const profiles = state
      ? (
          JSON.parse(state) as {
            profile?: { info_cache?: Record<string, { name?: string }>; last_used?: string };
          }
        ).profile
      : undefined;
    const names = profiles?.info_cache ?? {};
    const folders = entries
      .filter(
        (entry) =>
          entry.isDirectory() && (/^(Default|Profile \d+)$/.test(entry.name) || Object.hasOwn(names, entry.name)),
      )
      .map(({ name }) => name)
      .sort((a, b) =>
        a === profiles?.last_used ? -1 : b === profiles?.last_used ? 1 : a.localeCompare(b, undefined, { numeric: true }),
      );
    const results: Bookmark[] = [];

    for (const profile of folders) {
      const profileDir = join(root, profile);
      const profileName = names[profile]?.name || profile;

      for (const file of ["Bookmarks", "AccountBookmarks"]) {
        const json = await readOptional(join(profileDir, file), signal);
        if (json === undefined) continue;
        const data = JSON.parse(json) as { roots?: Record<string, BookmarkNode> };
        collectBookmarks(Object.values(data.roots ?? {}), "", profile, profileName, results);
      }

      const readingList = await readProfileReadingList(profileDir, signal);
      for (const item of readingList) {
        results.push({
          kind: "reading-list",
          title: item.title,
          url: item.url,
          folder: "Reading List",
          profile,
          profileName,
          read: item.read,
        });
      }
    }

    const unique = new Map(
      results.map((item) => [JSON.stringify([item.kind, item.profile, item.folder, item.title, item.url]), item]),
    );
    return [...unique.values()];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      throw new BrowserDataAccessError(error);
    }
    if (code === "ENOENT") return [];
    throw error;
  }
}

export async function loadBrowserBookmarks(signal: AbortSignal) {
  const browser = await defaultBrowser(signal);
  const root = join(homedir(), "Library", "Application Support", browser.folder);
  return { browser, bookmarks: await readBookmarks(root, signal) };
}

export function openInNewWindow(executable: string, { profile, url }: Bookmark) {
  return launchWindow(executable, [`--profile-directory=${profile}`, "--", url]);
}

export function openSearchWindow(executable: string, query: string) {
  const text = query.trim();
  if (!text) return launchWindow(executable, ["--", "chrome://newtab/"]);

  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", text);
  return launchWindow(executable, ["--", url.href]);
}

function launchWindow(executable: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["--new-window", ...args], {
      detached: true,
      stdio: "ignore",
    });
    // An existing browser normally accepts the request and the child exits.
    // A cold launch keeps the new browser process running.
    const started = setTimeout(resolve, 500);
    child.once("error", (error) => {
      clearTimeout(started);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(started);
      if (code === 0) resolve();
      else reject(new Error(`The browser exited with status ${code ?? signal}.`));
    });
    child.unref();
  });
}
