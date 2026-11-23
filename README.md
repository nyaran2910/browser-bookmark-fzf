# Browser Bookmark FZF

Run **Search Browser Bookmarks** in Raycast. The command uses the macOS default browser (Brave or Google Chrome) and reads bookmarks (`Bookmarks` and `AccountBookmarks`) and Reading List items (`Sync Data/LevelDB`) from its profiles. Search with fzf by title, URL, folder, reading list status (`read` / `unread`), or profile, and optionally narrow the view with the All / Bookmarks / Reading List filter dropdown. Press Enter to open the item in a new window in its own profile.

Install [fzf](https://github.com/junegunn/fzf) via Homebrew, Nix, or another installation on your PATH. You can also set **FZF Executable** in the extension settings.

Press **⌘Enter** to open a new window in the default browser and put the current search text in its address bar. The text stays ready to edit or submit, even when there are no search matches.

If macOS blocks browser data access, choose **Open Files & Folders Settings** from the error screen. Expand **Raycast** under **System Settings → Privacy & Security → Files & Folders** and enable access to Brave Browser or Google Chrome. Return to the command and use **Reload**.

The command searches HTTP and HTTPS bookmarks and Reading List items stored in the browser's local profile data without modifying or locking the browser database.
