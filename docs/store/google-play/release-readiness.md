# Google Play release readiness (owner checklist)

GizeCat is **not on Google Play** and nothing here says it will be, or when. Do not state or imply availability anywhere until a listing is live. Google's rules below were read on 2026-11-08 and they change; check them again when you act.

Nothing in 1.4.0 has been executed on any device. Statuses use the 1.4.0 vocabulary in [../../platforms/README.md](../../platforms/README.md#status-vocabulary-for-140).

## Before anything else

| | Item | Status |
|---|---|---|
| [ ] | Run the signed app on a real Android tablet: rotation, split screen, background and return, profile save and load | THEORETICALLY_COMPATIBLE_NOT_EXECUTED |
| [ ] | Create the upload key and sign the AAB ([android-signing.md](../../platforms/android-signing.md)) | REQUIRES_OWNER_CREDENTIALS |

## Account

| | Item | Status |
|---|---|---|
| [ ] | Google Play developer account, personal or organisation: the owner's decision | REQUIRES_OWNER_CREDENTIALS |
| [ ] | Identity verification that Play Console requires for the account | REQUIRES_OWNER_CREDENTIALS |
| [ ] | **Testing requirement.** Personal accounts "created after November 13, 2023" need "a minimum of 12 testers who have been opted in continuously" "for at least 14 days" in a closed test before applying for production access | REQUIRES_OWNER_CREDENTIALS |
| [ ] | **Android developer verification.** Check the Play Console home page for the app's registration. Google says "Google Play automatically registers 99% of apps. Use Play Console to manually register remaining apps or those distributed outside Google Play", which covers the GitHub APK. Google's timeline: protections begin on 30 September 2026 for installs from participating stores in Brazil, Indonesia, Singapore and Thailand on certified devices, and expand globally in 2027. Read Google's guides for how this applies to the APK outside Play | REQUIRES_OWNER_CREDENTIALS |

## The app entry

| | Item | Status |
|---|---|---|
| [x] | Application id `io.github.gizeverse.gizecat`. Permanent after the first upload | IMPLEMENTED |
| [x] | **Target API.** `targetSdk = 36`. Google requires "Android 16 (API level 36)" or higher for new apps and updates from August 31, 2026 | IMPLEMENTED |
| [x] | Minimum Android 10 (API 29), no forced orientation, resizable | IMPLEMENTED |
| [ ] | AAB format, signed with the upload key: `GizeCat-<version>-android.aab` | REQUIRES_OWNER_CREDENTIALS (unsigned AAB: COMPILED_OR_PACKAGED) |
| [ ] | Play App Signing: decide before the first upload ([section 2 of the signing guide](../../platforms/android-signing.md#2-decide-how-play-and-the-github-apk-relate)) | REQUIRES_OWNER_CREDENTIALS |
| [ ] | Free or paid. GizeCat has no ads or purchases. The owner decides | REQUIRES_OWNER_CREDENTIALS |

## Store listing

| | Item | Status |
|---|---|---|
| [ ] | Name, short and full description ([listing.md](listing.md)), reviewed against the running app | Draft text IMPLEMENTED; publishing REQUIRES_OWNER_CREDENTIALS |
| [ ] | Icon, feature graphic, screenshots ([assets.md](assets.md)) | NOT_IMPLEMENTED |
| [ ] | **Public contact email.** Required to publish. The owner chooses one; none is given here | REQUIRES_OWNER_CREDENTIALS |
| [ ] | Website: optional. The owner chooses whether to give one | REQUIRES_OWNER_CREDENTIALS |

## Privacy policy

This is required even though the app collects nothing: "You must link to a privacy policy on your store listing and within your app, even if your app doesn't access personal or sensitive user data".

| | Item | Status |
|---|---|---|
| [ ] | **Choose the public address** for the policy. It must be "publicly accessible and non-geofenced", and not a PDF. No address is given here because none exists | REQUIRES_OWNER_CREDENTIALS |
| [ ] | The policy must name the developer or the app, and give "a privacy point of contact or a mechanism to submit inquiries", and cover the data handled, retention and deletion. Base it on [data-safety.md](data-safety.md) and [docs/PRIVACY.md](../../PRIVACY.md); the contact is the owner's to choose | REQUIRES_OWNER_CREDENTIALS |
| [ ] | **Policy inside the app.** Google asks for "a privacy policy link or text within the app itself". Settings already has a short **Privacy** section. The app has no internet access and cannot open links, so a link would do nothing: the owner must decide whether that text is enough or the full policy text should be added there | Short text IMPLEMENTED; full policy NOT_IMPLEMENTED |

## App content declarations (Play Console, App content)

| | Item | What to base the answer on | Status |
|---|---|---|---|
| [ ] | Ads | The app contains no ads | REQUIRES_OWNER_CREDENTIALS |
| [ ] | App access | Everything works with no login | REQUIRES_OWNER_CREDENTIALS |
| [ ] | Advertising ID, if asked | Not used | REQUIRES_OWNER_CREDENTIALS |
| [ ] | Data safety | [data-safety.md](data-safety.md): nothing collected or shared | REQUIRES_OWNER_CREDENTIALS |
| [ ] | **Content rating** (IARC questionnaire). Required: unrated apps may be removed | The owner answers from what the app shows. Be accurate about the gestures: the cat can be picked up, dropped and flicked (thrown). The app has no user-to-user contact and no purchases | REQUIRES_OWNER_CREDENTIALS |
| [ ] | Target audience | The owner decides, then see below | REQUIRES_OWNER_CREDENTIALS |

### Families policy note

A cat character can appeal to children, and Google says imagery or terminology aimed at children can affect its assessment of the declared audience, whatever you select.

If any target age group includes children, the [Families policy](https://support.google.com/googleplay/android-developer/answer/9893335) applies. GizeCat's facts help: no ads, no data collection, no third-party SDKs beyond AndroidX, no social features, no location. Points to read closely:

- The policy says apps must not merely wrap a website in a WebView. GizeCat is a WebView app, but it packages all of its content and loads no website. Be ready to explain that.
- Content accessible to children must be appropriate for them, and your answers on target audience, data safety and content rating have to agree.

Choosing the audience is a judgement for the owner, with legal weight (COPPA, GDPR). This page gives no advice on which to pick.

## Rollout

| | Item | Status |
|---|---|---|
| [ ] | Internal test track first; then closed test (see the testing requirement above) | REQUIRES_OWNER_CREDENTIALS |
| [ ] | Read Google's pre-launch report if one is produced, and fix what it finds | REQUIRES_OWNER_CREDENTIALS |
| [ ] | Production, only after a real device run and a complete checklist | REQUIRES_OWNER_CREDENTIALS |
| [ ] | After the listing is live, update the README and the release notes with what is actually available | REQUIRES_OWNER_CREDENTIALS |

## Sources

Read on 2026-11-08.

- [Target API level requirements](https://support.google.com/googleplay/android-developer/answer/11926878)
- [App testing requirements for new personal accounts](https://support.google.com/googleplay/android-developer/answer/14151465)
- [Prepare your app for review (App content)](https://support.google.com/googleplay/android-developer/answer/9859455)
- [User Data policy (privacy policy rules)](https://support.google.com/googleplay/android-developer/answer/10144311)
- [Content ratings](https://support.google.com/googleplay/android-developer/answer/9859655)
- [Android developer verification](https://developer.android.com/developer-verification)
