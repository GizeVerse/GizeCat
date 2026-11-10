# Take your cat to another device (1.4.0 release candidate)

GizeCat can save your cat to a file and load that file on another computer, an iPad or an Android tablet. Nothing is uploaded and there is no account.

**Status:** IMPLEMENTED. Like everything in 1.4.0 it has **never run on a device**, so these steps come from the code. Statuses use the 1.4.0 vocabulary in [README.md](README.md#status-vocabulary-for-140).

## A copy, not a sync

- The file goes only where you put it. GizeCat never sends it anywhere.
- After a load there are two separate cats. What one does later does not reach the other.
- To bring changes back, save and load again.
- Without a file, each device and each app has its own cat. A Safari tab and an iPad's Home Screen app can count as two places.

## What the file holds

| Part | What is in it |
|---|---|
| The cat | Its name, its identity (`catId`), its birth time, and its 7 personality traits |
| Look | Coat, style, size, opacity, animation speed, shadow and emotes |
| Preferences | Behaviour, handling and sound settings, such as activity, chase length, patience and volume |
| What it has learned | Counters, learned habits and bond. **Only if you tick "Include what it has learned"** |

The file is named `gizecat-<name>-<YYYY-MM-DD>.json`. It is plain, unencrypted JSON of at most 64 KiB. Anyone who has it can read your cat's name and settings. Its format is `gizeverse-character-profile`, version 1.0 (`src/shared/profileTransfer.ts`).

## What it never holds

- API keys
- Screen-analysis, AI or consent settings, and exclusion lists
- Window titles, display ids, screen positions or favourite spots
- Folder paths
- Startup, shortcut, Dock icon, multi-monitor, click-through and "hide from screenshots" settings
- Diagnostics
- Moods, recent memories and timestamps

## Save and load, device by device

Every device has the same section: **Take your cat to another device**.

| Device | Where to find it | Saving | Loading |
|---|---|---|---|
| Windows | Settings → Personality | **Save to file…** opens the Windows save dialog | **Load from file…** opens the Windows open dialog |
| macOS | Settings → Personality | **Save to file…** opens the Mac's save dialog | **Load from file…** opens the Mac's open dialog |
| iPad, Home Screen app | Toolbar → Settings | **Save my cat to a file** opens the share sheet. Choose **Save to Files** | **Load a cat from a file** opens the file picker |
| iPad, Safari tab | Toolbar → Settings | **Save my cat to a file** is a download | As above |
| Android app | Toolbar → Settings | **Save my cat to a file** opens the system "save as" screen, at the place you choose | **Load a cat from a file** opens the system file picker |
| Web app in Chrome or a desktop browser | Toolbar → Settings | **Save my cat to a file** is a download | **Load a cat from a file** opens the file picker |

The iPad share-sheet route comes from platform knowledge and has not been checked on an iPad.

To move a cat:

1. On the first device, save the cat to a file.
2. Move the file to the other device in any way you like: a USB stick, AirDrop, your own cloud folder. GizeCat is not involved.
3. On the other device, load the file and confirm.

## Confirming a load

Nothing changes until you confirm.

1. You see **Load \<name\>?**, the version and device that saved the file, and what would change.
2. You choose what to load: **Name, age and personality**, **Look (coat, style, size and effects)**, **Behaviour, handling and sound preferences**, and **What it has learned**. What it has learned can only be loaded together with the cat itself.
3. Choose **Load** to apply it. Or cancel, and nothing changes.

**If it is the same cat**, the values you choose replace the ones here. Its memory stays unless you choose to load what it has learned.

**If it is a different cat**, loading it replaces the cat on this device. The current cat's mood, memories and what it has learned here are cleared. Its place on the screen stays. **This cannot be undone**, so save the current cat first if you want to keep it.

## An import never weakens privacy

A file never changes screen analysis or AI, API keys, startup, shortcuts, click-through, hiding from screenshots, multiple monitors or diagnostics. Those stay as they are on the device.

It also never switches tab-strip reading back on. If walking on browser, File Explorer or Terminal tabs is off on this device, it stays off, and the preview says so.

Each file is read as untrusted input ([threat model](../THREAT_MODEL.md), T17). A file from a newer major format version is refused. A newer minor version loads, and a few details may not.

## If something goes wrong

See [Importing a profile](troubleshooting.md#importing-a-profile).
