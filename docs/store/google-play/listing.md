# Google Play store listing: draft text

**A draft for the owner, not a live listing.** GizeCat is not on Google Play. Every behaviour below exists in code and has never run on an Android device (THEORETICALLY_COMPATIBLE_NOT_EXECUTED), so run the app on a real tablet first and correct anything that does not match what you see.

Limits, from the Play Console help: app name 30 characters, short description 80, full description 4,000. The lengths given here are the text's actual lengths.

Contact email, website and privacy policy address are not filled in here. The owner chooses them ([release-readiness.md](release-readiness.md)).

## App name (7 of 30)

```text
GizeCat
```

The same as the label on the launcher icon.

## Short description (76 of 80)

```text
A living pet cat for your tablet. No account, no ads and no internet access.
```

## Full description (1,502 of 4,000)

```text
GizeCat is a small animated cat that lives in its own window on your Android tablet, and, if you let it, walks over your other apps. It is the first character of GizeVerse.

Your cat has a name, a coat and a personality of its own. It wanders, rests and naps at its own pace, and it remembers what it has learned from one visit to the next.

Play with your cat
- Stroke it back and forth to pet it, or tap it to say hello.
- Press and hold it for a moment, then drag to pick it up. Let go to drop it, or flick to throw it.
- Call it, send it to sleep or wake it, and pause it from the toolbar.

Make it yours
- Name it and choose a coat: ginger, grey, black, tuxedo, calico, siamese or cream.
- Choose a smooth or a pixel drawing style, its size, and whether it casts a shadow.
- Pick a personality: calm, playful or mischievous.
- Soft synthesized meows, chirps and purrs, if you turn sound on. They are made on the device, and the microphone is never used.

Private by design
- No account, no ads, no analytics.
- GizeCat has no internet access, so the app itself cannot send your data anywhere. If you turn on the optional floating cat, it asks to display over other apps and to show a small notification; it only draws the cat and never reads your screen. Without those, the cat lives inside the app.
- Your cat is saved in the app's private storage on your device.
- To take your cat to another device, save it to a file at a place you choose, and load that file there. It is a copy, not a sync.

Good to know
- The cat lives inside GizeCat's own window. If you turn on the optional floating cat, it can also walk over your other apps; that needs Android's "Display over other apps" permission, which you turn on yourself, and you can stop it at any time.
- Designed for tablets, in any orientation and in split screen.
- Needs Android 10 or later and an up-to-date Android System WebView.
```

## Category and tags (owner's choice)

Suggested category: **Entertainment**. The owner picks the category and tags in the Play Console.

## Wording rules for later edits

- Say only what the app does. Do not add rankings, awards, or "best" or "number one" claims, and no calls to action such as "download now". (Keep this in mind for images too: see [assets.md](assets.md).)
- Do not say or imply that GizeCat is available on Google Play, in the listing or anywhere else, before the listing is live.
- Keep "no internet access" only as long as the manifest stays that way, and describe the permissions exactly as [permissions.md](permissions.md) lists them. Do not write "asks for no permissions": the floating cat asks for four. The overlay and its foreground service need Play's declarations, which are not filed and not guaranteed.
