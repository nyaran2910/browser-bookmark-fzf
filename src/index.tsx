import {
  Action,
  ActionPanel,
  Clipboard,
  closeMainWindow,
  Color,
  getFrontmostApplication,
  getPreferenceValues,
  Icon,
  List,
  open,
  openExtensionPreferences,
  showToast,
  Toast,
} from "@raycast/api";
import { setTimeout as delay } from "node:timers/promises";
import { useEffect, useMemo, useState } from "react";
import {
  type Bookmark,
  type BrowserItemKind,
  BrowserDataAccessError,
  defaultBrowser,
  loadBrowserBookmarks,
  openInNewWindow,
  openNewTabWindow,
} from "./browser";
import { findFzf, searchBookmarks } from "./fzf";

type Catalog = Awaited<ReturnType<typeof loadBrowserBookmarks>> & { fzf: string };
type Scope = "all" | BrowserItemKind;

function itemAccessories(item: Bookmark): List.Item.Accessory[] {
  if (item.kind === "reading-list") {
    return [
      {
        tag: item.read
          ? { value: "Reading List · Read", color: Color.SecondaryText }
          : { value: "Reading List", color: Color.Blue },
      },
      { text: item.profileName, tooltip: item.read ? "Reading List (Read)" : "Reading List (Unread)" },
    ];
  }
  return [{ text: item.profileName, tooltip: item.folder }];
}

export default function Command() {
  const { fzfPath } = getPreferenceValues<{ fzfPath?: string }>();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState<{ catalog?: Catalog; error?: Error }>({});
  const [result, setResult] = useState<{
    catalog: Catalog;
    scope: Scope;
    query: string;
    matches: Bookmark[];
    error?: string;
  }>();

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setSource({});
    void Promise.all([loadBrowserBookmarks(signal), findFzf(fzfPath)]).then(
      ([catalog, fzf]) => {
        if (!signal.aborted) setSource({ catalog: { ...catalog, fzf } });
      },
      (error: Error) => {
        if (!signal.aborted) setSource({ error });
      },
    );
    return () => controller.abort();
  }, [fzfPath, revision]);

  const { catalog } = source;
  const scopedItems = useMemo(() => {
    if (!catalog) return [];
    return scope === "all" ? catalog.bookmarks : catalog.bookmarks.filter((item) => item.kind === scope);
  }, [catalog, scope]);

  useEffect(() => {
    if (!catalog) return;
    const controller = new AbortController();
    const { signal } = controller;
    void searchBookmarks(scopedItems, query, catalog.fzf, signal).then(
      (matches) => {
        if (!signal.aborted) setResult({ catalog, scope, query, matches });
      },
      (error: Error) => {
        if (!signal.aborted) setResult({ catalog, scope, query, matches: [], error: error.message });
      },
    );
    return () => controller.abort();
  }, [catalog, scope, scopedItems, query]);

  const current = result?.catalog === catalog && result?.scope === scope && result?.query === query ? result : undefined;
  const error = source.error?.message ?? current?.error;
  const accessBlocked = source.error instanceof BrowserDataAccessError;
  const loading = !error && !current;
  const reload = <Action title="Reload" icon={Icon.ArrowClockwise} onAction={() => setRevision((value) => value + 1)} />;
  const settings = <Action title="Open Extension Settings" icon={Icon.Gear} onAction={openExtensionPreferences} />;

  async function openBookmark(executable: string, bookmark: Bookmark) {
    try {
      await openInNewWindow(executable, bookmark);
      await closeMainWindow();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: bookmark.kind === "reading-list" ? "Couldn’t Open Reading List Item" : "Couldn’t Open Bookmark",
        message: (error as Error).message,
      });
    }
  }

  async function fillAddressBar() {
    try {
      const browser = catalog?.browser ?? await defaultBrowser(AbortSignal.timeout(5000));
      await closeMainWindow();
      await openNewTabWindow(browser.executable);
      if (!query) return;

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if ((await getFrontmostApplication()).bundleId === browser.bundleId) {
          await Clipboard.paste(query);
          return;
        }
        await delay(50);
      }
      throw new Error(`${browser.name} did not come to the foreground.`);
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Couldn’t Fill the Browser Address Bar",
        message: (error as Error).message,
      });
    }
  }

  const addressBarAction = <Action title="Fill Address Bar in New Window" icon={Icon.Window} onAction={fillAddressBar} />;
  const filesSettings = (
    <Action
      title="Open Files & Folders Settings"
      icon={Icon.Gear}
      onAction={() => open("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")}
    />
  );

  const emptyTitle = accessBlocked
    ? "Browser Data Access Blocked"
    : error
      ? "Search Unavailable"
      : loading
        ? "Searching…"
        : query.trim()
          ? "No Matches"
          : scope === "reading-list"
            ? "No Reading List Items"
            : scope === "bookmark"
              ? "No Bookmarks"
              : "No Bookmarks or Reading List Items";

  return (
    <List
      navigationTitle={catalog ? `${catalog.browser.name} Bookmarks & Reading List` : "Browser Bookmarks & Reading List"}
      filtering={false}
      isLoading={loading}
      onSearchTextChange={setQuery}
      searchBarPlaceholder="Search bookmarks and reading list with fzf…"
      searchBarAccessory={
        <List.Dropdown tooltip="Filter Source" value={scope} onChange={(value) => setScope(value as Scope)}>
          <List.Dropdown.Item title="All" value="all" icon={Icon.AppWindowList} />
          <List.Dropdown.Item title="Bookmarks" value="bookmark" icon={Icon.Bookmark} />
          <List.Dropdown.Item title="Reading List" value="reading-list" icon={Icon.Book} />
        </List.Dropdown>
      }
    >
      <List.EmptyView
        title={emptyTitle}
        description={error}
        actions={
          <ActionPanel>
            {accessBlocked ? filesSettings : reload}
            {addressBarAction}
            {accessBlocked && reload}
            {settings}
          </ActionPanel>
        }
      />
      {current?.matches.map((item) => (
        <List.Item
          key={JSON.stringify([item.kind, item.profile, item.folder, item.title, item.url])}
          icon={item.kind === "reading-list" ? Icon.Book : Icon.Bookmark}
          title={item.title}
          subtitle={item.url}
          accessories={itemAccessories(item)}
          actions={
            <ActionPanel>
              <Action
                title="Open in New Window"
                icon={Icon.Window}
                onAction={() => openBookmark(current.catalog.browser.executable, item)}
              />
              {addressBarAction}
              <Action.CopyToClipboard title="Copy URL" content={item.url} />
              {reload}
              {settings}
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
