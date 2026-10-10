# onenote_obsidian

OneNote-style navigation and freeform pages for Obsidian. The plugin in this repository is called
**Section Pages** (plugin id `section-pages`). It replaces the file explorer with a two-pane
sections-and-pages panel, and adds freeform pages where you can click anywhere and type. The normal
Obsidian editor is left alone.

Status: personal project, version 0.2.5, developed on Obsidian 1.14 for desktop (macOS).
Not in the community plugin directory. See [docs/NOTES.md](docs/NOTES.md) for what has and has
not been tested.

## What it does

**Two-pane navigation**

- Left pane: folders shown as sections, each with a colored strip. Folders that only hold other
  folders are groups: no strip, click to open or close.
- Right pane: the pages of the selected section as a flat list you order by hand, with up to five
  indent levels.
- A page with subpages is still an ordinary note. No folder is created for it, and no "folder
  note" is needed.
- Subpages collapse and expand. The plugin remembers what was collapsed, each section's color,
  the pane split, and the last page you had open in each section.

**Freeform pages**

- Click an empty spot and type. A text box appears there; an empty box disappears when you leave it.
- Boxes render Markdown (headings, lists, bold, links, embedded images). Click a box to edit it.
- Drag the bar at the top of a box to move it. Drag the right edge, bottom edge or corner to resize.
- Paste or drop an image into a box or onto the page. It is saved with the page's name.
- A freeform page is still a `.md` file that reads as a normal note anywhere else.

## Install

There is no build step. The plugin is the three files at the top of this repository.

1. In your vault, create the folder `.obsidian/plugins/section-pages/`.
2. Copy `main.js`, `manifest.json` and `styles.css` into it.
3. In Obsidian, open **Settings → Community plugins**. If Restricted mode is on, turn it off.
4. Under **Installed plugins**, switch on **Section Pages**.
5. Click the book icon in the left ribbon to open the panel.

To update, replace the three files, then switch the plugin off and on again in the same settings
page (or restart Obsidian). Turning the plugin off closes any open freeform tabs; the pages
themselves are not affected.

### Recommended Obsidian settings

**Hide the properties block in notes.** The plugin stores each page's position in the note's
properties (`page-order`, `page-level`, and `page-type` for freeform pages). By default Obsidian
shows these in a "Properties" box at the top of every note. To hide it:

- **Settings → Editor → Properties in document → Hidden**

The values stay in the files and the plugin keeps working. You can still see them in the
Properties side panel. This setting is per vault. Do not edit the numbers by hand unless you mean
to move the page.

**Keep images next to their section.** By default Obsidian puts every pasted image in the vault
root. To keep them with the section they belong to:

- **Settings → Files and links → Default location for new attachments → In subfolder under current folder**
- Subfolder name: `assets`
- Leave **Automatically update internal links** on.

The plugin hides folders named `assets` from the section list. If you use another name, set it in
the plugin's own settings (**Attachments folder name**).

### Plugin settings

- **Root folder**: the folder whose subfolders become sections. Empty means the whole vault.
- **Attachments folder name**: folders with this name are hidden from the section list.

## Using it

### Sections and groups

| To do this | Do this |
|---|---|
| Add a section | **+ Add section** at the bottom of the left pane |
| Add a group | **+ Add group** |
| Add a section or group inside another | Right-click it → **New section inside** / **New group inside** |
| Change a section's color | Right-click → **Color...** |
| Rename or delete | Right-click → **Rename...** / **Delete section** |
| Move a section into a group | Drag it onto the group |
| Move it out of a group | Drag it onto the empty space below the list, or right-click → **Move out of ...** |

A group has no pages of its own. If a note is placed directly in a group's folder, the folder is
shown as a normal section.

### Pages

| To do this | Do this |
|---|---|
| Add a page | **+ Add page**, or right-click a page → **New page below** |
| Add a subpage | Right-click a page → **New subpage** |
| Make a page a subpage / undo | Select it, then **Tab** / **Shift+Tab** (or right-click) |
| Move between pages | **Up** / **Down** arrows |
| Reorder | Drag a page up or down. Its subpages move with it |
| Move to another section | Drag the page onto the section |
| Collapse or expand subpages | Click the chevron next to the page |
| Rename or delete | Right-click → **Rename...** / **Delete page** |

Clicking a page shows it but keeps the keyboard focus in the page list, as OneNote does, so the
arrow keys and Tab act on pages. Click into the note to type, or double-click the page to go
straight to editing.

### Freeform pages

| To do this | Do this |
|---|---|
| Add a freeform page | **+ Add freeform page**, or right-click a page → **New freeform page below** |
| Add text | Click an empty spot and type |
| Edit a box | Click it. **Esc** or a click elsewhere finishes |
| Move a box | Drag the bar at its top |
| Resize a box | Drag its right edge, bottom edge or corner |
| Delete a box | Click its top bar to select it, then **Delete** |
| Add an image | Paste or drop it into a box or onto the page |
| See the raw Markdown | **Open as Markdown** button, top right of the page |
| Go back to freeform | **Open as freeform page** button, top right |
| Convert a normal page | Right-click it → **Convert to freeform page** (and back) |

"Open as Markdown" lasts until that tab shows another page.

Limits: while you edit a box you see raw Markdown in a plain text field. There is no live preview
and no link autocomplete inside boxes, because Obsidian has no supported way to place its own
editor in a custom view.

### Commands

All are in the command palette under "Section Pages": open the panel, new page, new freeform
page, make subpage, promote subpage, switch a page between freeform and Markdown view, convert a
page to freeform and back.

## How your notes are stored

Nothing is stored outside your vault, and the notes stay plain Markdown.

A normal page gets up to two properties:

```yaml
---
page-order: 300
page-level: 1
---
```

- `page-order` is the position inside the section. Lower comes first. Values start in steps of 100
  so a page can be dropped between two others without renumbering the rest.
- `page-level` is the indent, 1 to 4. Top-level pages do not have it.

A freeform page also has `page-type: freeform`, and each box is its text preceded by one comment
line that holds its position:

```markdown
---
page-type: freeform
page-order: 200
---

%% box x=40 y=60 w=420 %%

## Ideas for the trip
- Book the train

%% box x=520 y=60 w=300 h=180 %%

![[Trip 20261010-113907.png]]
```

`x`, `y` and `w` are in pixels. `h` is optional; without it a box is as tall as its text.
`%% ... %%` is Obsidian's comment syntax, so other tools show the text and hide the markers.

Colors, collapsed state, groups, the pane split and the last page per section are kept in the
plugin's `data.json` inside `.obsidian/plugins/section-pages/`. Deleting that file loses only
those; the page order and structure are in the notes.

The first time you reorder or indent in a section, every note in that section gets a
`page-order`. After that a move usually rewrites only the notes that moved.

## Development

See [docs/NOTES.md](docs/NOTES.md) for how the code is organised, the pitfalls found so far and
what is left to do, and [CHANGELOG.md](CHANGELOG.md) for the history.

```sh
node tests/logic.test.js    # ordering, indent and freeform save-format logic
node --check main.js        # syntax
```

The tests cover the pure logic only. Anything that touches Obsidian has to be checked in the app.
