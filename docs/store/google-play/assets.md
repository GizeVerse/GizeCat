# Google Play graphic assets: requirements

These are requirements only. **No Play feature graphic or screenshot exists, and none has been made up.** Screenshots must come from the real app running on a real device or emulator, which has not happened yet (NOT_IMPLEMENTED, and blocked until the app has run).

## Required for publishing

| Asset | Requirement |
|---|---|
| App icon | 512 × 512 px, 32-bit PNG with alpha, at most 1024 KB |
| Feature graphic | 1024 × 500 px, JPEG or 24-bit PNG without alpha |
| Screenshots | At least two across device types to publish; JPEG or 24-bit PNG without alpha |

**Icon source:** `build/icon.png` is the existing artwork: 512 × 512, 8-bit RGBA (that is, 32-bit with alpha), 68,834 bytes. Its format meets the requirement. Check how it looks in the Play Console's preview before using it.

## Screenshots by device type

Google allows up to 8 screenshots for each device type, and treats 7-inch and 10-inch tablets as device types.

| Device type | How many | Side lengths | Shape |
|---|---|---|---|
| Phone | Up to 8 | Shortest side at least 320 px, longest at most 3840 px | Longest side no more than twice the shortest |
| 7-inch tablet | "a minimum of 4", up to 8 | Between 1,080 and 7,680 px | 16:9 landscape or 9:16 portrait |
| 10-inch tablet | "a minimum of 4", up to 8 | Between 1,080 and 7,680 px | 16:9 landscape or 9:16 portrait |

Google's page does not say that tablet screenshots are mandatory, or give a file-size limit for phone or tablet screenshots. **GizeCat is made for tablets, so provide both tablet sets anyway.** Provide phone screenshots too if the app is offered on phones.

To be eligible for Google's recommendation formats that use screenshots, an app needs at least four, each 16:9 landscape (minimum 1920 × 1080) or 9:16 portrait (minimum 1080 × 1920).

## Content rules

- Show the actual in-app experience, and its core features.
- No fingers or people using the device.
- No hint of Google Play performance, rankings, accolades or awards.
- If you add a tagline, keep it to at most 20 % of the image. On large-screen images, leave out extra text that is not part of the app.
- Clean up the notification bar. Nothing blurry, distorted or pixelated. (The pixel drawing style is a real feature; if you show it, keep the image itself sharp.)
- The feature graphic follows the same honesty rules: the real cat, no invented scenes.

## Shots worth capturing, once the app runs

The cat on the floor in landscape and portrait; being petted; picked up; the settings sheet with coats and personalities; split screen next to another app. Show the cat inside GizeCat's own window, never over other apps, because the app cannot do that.

## Source

[Add preview assets to showcase your app](https://support.google.com/googleplay/android-developer/answer/9866151), checked on 2026-11-08. Google changes these, so check them again when you prepare the images.
