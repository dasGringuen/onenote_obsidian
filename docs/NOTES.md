# Developer notes

Notes for picking this up again later: how the code is organised, what was learned the hard way,
what has been checked, and what is left.

## Layout

```
main.js          the whole plugin, plain JavaScript, no build step
styles.css       panel and freeform-page styles
manifest.json    plugin id, version, minimum Obsidian version
versions.json    plugin version -> minimum Obsidian version
tests/           node tests for the pure logic
docs/NOTES.md    this file
```

`main.js` is written directly as the CommonJS file Obsidian loads. There is no TypeScript and no
bundler, so editing it and reloading the plugin is the whole loop.

## Parts of main.js

In file order:

1. **Constants.** Property names (`page-order`, `page-level`, `page-type`), `MAX_LEVEL` (4, so five
   levels), the section color palette, default plugin data.
2. **Pure logic.** No Obsidian calls, exported as `module.exports._logic` for the tests:
   - `sortPages`, `effectiveLevels`, `subtreeEnd`: the page list is flat; hierarchy comes from each
     page's level. A page can be at most one level deeper than the page above it, and
     `effectiveLevels` enforces that when reading.
   - `planOrders`: given the desired sequence and which pages moved, returns the `page-order` for
     each, changing as few notes as possible. Falls back to renumbering the section in steps of 100.
   - `splitFront`, `isFreeformText`, `parseBoxes`, `serializeBoxes`, `stripBoxMarkers`: the
     freeform save format.
3. **Modals.** Text prompt, delete confirmation, color picker.
4. **`NavView`** (view type `section-pages`). The two-pane panel. Rebuilds both lists on every
   `render()`; they are small.
5. **`FreeformView`** (view type `section-pages-freeform`). A `TextFileView` registered for `.md`
   through `canAcceptExtension`. Parses the note into boxes and writes it back.
6. **Settings tab.**
7. **`SectionPagesPlugin`.** Registration, commands, vault and workspace events, and every
   operation that changes files (new, rename, move, indent, convert).

## Where state lives

| What | Where |
|---|---|
| Page order and indent | Each note's properties: `page-order`, `page-level` |
| Freeform flag and boxes | The note: `page-type: freeform` and `%% box x= y= w= h= %%` lines |
| Section colors, groups, collapsed pages and groups, last page per section, active section, pane split, settings | The plugin's `data.json`, keyed by path |

`data.json` is keyed by path, so `onRename` remaps every key when a file or folder is renamed or
moved. Deleted paths leave stale keys behind; harmless, never cleaned up.

Putting order and indent in the notes was a deliberate choice: the structure travels with the notes
if the plugin is removed. The cost is that reordering edits note files.

## Things learned the hard way

- **Obsidian reuses a tab's view for the next file with an accepted extension.** Because
  `FreeformView` accepts `.md`, a normal note opened in a tab that showed a freeform page was
  loaded into `FreeformView`, displayed as one box, and saved with a box marker when edited. Fixed
  in 0.2.3: `setViewData` checks the file text with `isFreeformText`; a note that is not freeform
  is marked `foreign`, is never rendered or rewritten, and the tab is handed back to the Markdown
  view (`showInEditor`). `openPage` also avoids `leaf.openFile` when the tab holds a
  `FreeformView`. Keep this guard if the view code is reworked.
- **Opening a file focuses the editor.** Even with `{ active: false }`, a file loaded into the
  active tab takes keyboard focus. The page list takes focus back after the open resolves, and
  again 60 ms later. Without this, Tab in the page list typed a tab into the note.
- **A drag released over empty space fires a click on the common ancestor.** After moving a box,
  the page surface received a click and created a new box. `ignoreClickUntil` suppresses surface
  clicks for 300 ms after any drag ends.
- **Do not edit `.obsidian/app.json` while Obsidian is running.** Obsidian writes its in-memory
  settings back and the change is lost. Change settings in the UI.
- **Disabling the plugin closes open freeform tabs**, because the view type is unregistered.
- **Local changes versus changes on disk.** Reordering a page rewrites its properties while its
  freeform view may hold unsaved box edits. `setViewData` keeps the boxes, takes the new
  properties, and saves again (`localDirty`). `lastBody` skips a rebuild when only the properties
  changed, so an edit in progress is not interrupted.
- **Embedded images in rendered boxes.** `MarkdownRenderer.render` can leave `![[image]]` as an
  empty placeholder. `fixEmbeds` runs 200 ms after rendering and fills in any that are still empty.
- **Menus use `showAtMouseEvent`; drag and drop for pages and sections uses HTML5 drag events;
  moving and resizing boxes uses pointer events with pointer capture.**

## What has been checked, as of 0.2.5

Checked by operating Obsidian 1.14.4 on macOS:

- The panel: sections, colors, groups, collapsing, remembered state, last page per section.
- Tab and Shift+Tab indenting through all five levels, arrow-key navigation.
- New page, new freeform page and new group from the footer buttons.
- Freeform: creating a box by clicking, typing, Markdown rendering, saving and reopening.
- Freeform to Markdown view and back; opening a normal note from a freeform tab.
- Image paste into a freeform page (done by hand: files landed in the section's `assets` folder,
  named after the page).

Not checked yet:

- Dragging pages to reorder, and onto a section.
- Dragging sections into and out of groups, and "Move out of ...".
- Every right-click menu item, including "New subpage", color, rename, delete, convert.
- Moving and resizing boxes, including the corner handle.
- Dropping image files onto a freeform page.
- Mobile, and Obsidian versions other than 1.14.4.

The automated tests cover only the pure logic.

## Known limits

- Boxes are edited in a plain text field: no live preview, no link autocomplete, no Obsidian
  hotkeys. Obsidian has no supported API for placing its editor in a custom view; Canvas does it
  internally, and hooking into that is possible but can break on updates.
- Sections are sorted by name. Only pages have a hand order.
- Moving a page to another section does not move its images. The links still resolve, but the
  files stay in the old section's `assets` folder.
- Images pasted into a normal note get Obsidian's default "Pasted image ..." name. Only freeform
  pages name images after the page.
- Notes changed outside the panel (another device, another tool) are picked up on the next
  render, but a note with no `page-order` simply sorts after the ordered ones, by name.
- The rest of Obsidian's window (title bar, tab bar, ribbon, editor) is not restyled, and the
  built-in file explorer is still there.

## Ideas for later

- Images follow their page when it moves; name pasted images after the page everywhere.
- A CSS snippet or theme for the rest of the window, and an option to hide the built-in explorer.
- Hand ordering for sections.
- A small icon in the page list to mark freeform pages.
- Selecting several boxes, and snapping or aligning them.
- The real Obsidian editor inside boxes, if the fragility is acceptable.
- Mobile layout.
- A proper TypeScript project with the official `obsidian` type definitions, if the plugin grows.

## Working on it

Install into a test vault, never the real one, while changing anything that writes files:

1. Copy `main.js`, `manifest.json` and `styles.css` to
   `<vault>/.obsidian/plugins/section-pages/`.
2. In **Settings → Community plugins**, switch the plugin off, press the reload icon next to
   "Installed plugins", and switch it on again. The version number in that list should match
   `manifest.json`; if it does not, the files were not replaced.
3. Open the developer console with **View → Toggle Developer Tools** to see errors.

Before committing:

```sh
node --check main.js
node tests/logic.test.js
```

## Releasing

BRAT and Obsidian's own updater install from GitHub releases, not from the files on `main`. A
release must have `main.js`, `manifest.json` and `styles.css` attached as assets, and its tag and
title must be exactly the `version` in `manifest.json`, with no `v` in front (`0.2.5`, not `v0.2.5`).

1. Bump `version` in `manifest.json`, add the version to `versions.json`, add an entry to
   `CHANGELOG.md`.
2. Run the checks above, commit and push.
3. Create the release. With the GitHub CLI:

   ```sh
   gh release create 0.2.5 main.js manifest.json styles.css --title "0.2.5" --notes "See CHANGELOG.md"
   ```

   Or on the website: **Releases → Draft a new release**, type the version as a new tag, use the
   same text as the title, drag the three files into the assets box, and publish.

BRAT picks the release with the highest version number. Draft releases are not visible to it.

## Background

The project started from looking at how the PhotoCraft project was built with AI agents, and from
wanting OneNote's navigation without giving up Obsidian's editor. The existing OneNote-style
plugins treat hierarchy as folders; the point of this one is that subpages are ordinary notes in
the same folder, ordered and indented by hand.
