# Browser Bookmark FZF

Run **Search Browser Bookmarks** in Raycast. The command uses the macOS default browser (Brave or Google Chrome) and reads local and account bookmarks from its profiles. Search with fzf by title, URL, folder, or profile. Press Enter to open the bookmark in a new window in its own profile.

Install [fzf](https://github.com/junegunn/fzf) via Homebrew, Nix, or another installation on your PATH. You can also set **FZF Executable** in the extension settings.

If macOS blocks browser data access, choose **Open Files & Folders Settings** from the error screen. Expand **Raycast** under **System Settings → Privacy & Security → Files & Folders** and enable access to Brave Browser or Google Chrome. Return to the command and use **Reload Bookmarks**.

The command searches HTTP and HTTPS bookmarks stored in the browser's local JSON bookmark files.
