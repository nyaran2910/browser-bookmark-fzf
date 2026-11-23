# Browser Bookmark FZF

Run **Search Browser Bookmarks** in Raycast. The command uses the macOS default browser (Brave or Google Chrome) and reads local and account bookmarks from its profiles. Search with fzf by title, URL, folder, or profile. Press Enter to open the bookmark in a new window in its own profile.

Install [fzf](https://github.com/junegunn/fzf) via Homebrew, Nix, or another installation on your PATH. You can also set **FZF Executable** in the extension settings. If macOS asks whether Raycast can access the browser's data, allow access and use **Reload Bookmarks**.

The command searches HTTP and HTTPS bookmarks stored in the browser's local JSON bookmark files.
