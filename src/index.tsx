import {
  Action, ActionPanel, closeMainWindow, getPreferenceValues, Icon, List, openExtensionPreferences, showToast, Toast,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { type Bookmark, loadBrowserBookmarks, openInNewWindow } from "./browser";
import { findFzf, searchBookmarks } from "./fzf";

type Catalog = Awaited<ReturnType<typeof loadBrowserBookmarks>> & { fzf: string };

export default function Command() {
  const { fzfPath } = getPreferenceValues<{ fzfPath?: string }>();
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState<{ catalog?: Catalog; error?: string }>({});
  const [result, setResult] = useState<{ catalog: Catalog; query: string; matches: Bookmark[]; error?: string }>();

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setSource({});
    void Promise.all([loadBrowserBookmarks(signal), findFzf(fzfPath)]).then(
      ([catalog, fzf]) => { if (!signal.aborted) setSource({ catalog: { ...catalog, fzf } }); },
      (error: Error) => { if (!signal.aborted) setSource({ error: error.message }); },
    );
    return () => controller.abort();
  }, [fzfPath, revision]);

  const { catalog } = source;
  useEffect(() => {
    if (!catalog) return;
    const controller = new AbortController();
    const { signal } = controller;
    void searchBookmarks(catalog.bookmarks, query, catalog.fzf, signal).then(
      (matches) => { if (!signal.aborted) setResult({ catalog, query, matches }); },
      (error: Error) => { if (!signal.aborted) setResult({ catalog, query, matches: [], error: error.message }); },
    );
    return () => controller.abort();
  }, [catalog, query]);

  const current = result?.catalog === catalog && result?.query === query ? result : undefined;
  const error = source.error ?? current?.error;
  const loading = !error && !current;
  const reload = <Action title="Reload Bookmarks" icon={Icon.ArrowClockwise} onAction={() => setRevision((value) => value + 1)} />;
  const settings = <Action title="Open Extension Settings" icon={Icon.Gear} onAction={openExtensionPreferences} />;

  async function openBookmark(executable: string, bookmark: Bookmark) {
    try {
      await openInNewWindow(executable, bookmark);
      await closeMainWindow();
    } catch (error) {
      await showToast({ style: Toast.Style.Failure, title: "Couldn’t Open Bookmark", message: (error as Error).message });
    }
  }

  return (
    <List
      navigationTitle={catalog ? `${catalog.browser.name} Bookmarks` : "Browser Bookmarks"}
      filtering={false}
      isLoading={loading}
      onSearchTextChange={setQuery}
      searchBarPlaceholder="Search bookmark titles, URLs, and folders with fzf…"
    >
      <List.EmptyView
        title={error ? "Search Unavailable" : loading ? "Searching…" : query.trim() ? "No Matches" : "No Bookmarks"}
        description={error}
        actions={<ActionPanel>{reload}{settings}</ActionPanel>}
      />
      {current?.matches.map((bookmark) => (
        <List.Item
          key={JSON.stringify([bookmark.profile, bookmark.folder, bookmark.title, bookmark.url])}
          icon={Icon.Bookmark}
          title={bookmark.title}
          subtitle={bookmark.url}
          accessories={[{ text: bookmark.profileName, tooltip: bookmark.folder }]}
          actions={(
            <ActionPanel>
              <Action title="Open in New Window" icon={Icon.Window} onAction={() => openBookmark(current.catalog.browser.executable, bookmark)} />
              <Action.CopyToClipboard title="Copy URL" content={bookmark.url} />
              {reload}
              {settings}
            </ActionPanel>
          )}
        />
      ))}
    </List>
  );
}
