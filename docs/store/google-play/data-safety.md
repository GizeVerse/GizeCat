# Google Play Data safety: answers and evidence

This is what the owner should enter in the Play Console's **Data safety** form, and why. The form itself is REQUIRES_OWNER_CREDENTIALS and has not been filled in. Answers describe the code as it is in 1.4.0; recheck them if the app changes.

## The answer

| Question in the form | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **No** |

Google says choosing "No" skips the follow-up questions on encryption in transit and on deletion requests. Its article does not spell out what else remains, so follow the form as it appears.

Even with nothing collected, Google requires the form to be completed **and a privacy policy link** ([release-readiness.md](release-readiness.md#privacy-policy)).

## Why "No" is accurate

Google's definitions: "'Collect' means transmitting data from your app off a user's device". Data "that is only processed locally on the user's device and not sent off device" does not need to be disclosed as collected. Transfers "based on a specific user-initiated action, where the user reasonably expects the data to be shared" do not count as sharing.

| Data | Where it is | Does the app send it off the device? |
|---|---|---|
| The cat's name, look, personality, mood and what it has learned; the settings | The app's private WebView storage on the device | No |
| A saved profile file | Only when the user taps **Save my cat to a file**. Android's own "save as" screen asks where to put it, and the app writes only there | No. The user chooses the place, and what happens to the file after that is the user's own action |
| A loaded profile file | Only the single file the user picks in Android's file picker. It is read and checked on the device | No |
| Sounds | Synthesized on the device. No recording, no microphone | No |

Why the app has no way to transmit (the Android items are pinned by `tests/unit/android/androidProject.test.ts`):

- **No `INTERNET` permission**, so Android does not give the app network access.
- The page's content security policy has `connect-src 'none'`.
- The native layer answers every request outside the app's own bundled files with an empty 404, and the WebView never navigates away from them.
- No analytics, advertising, crash-reporting or account library: the only dependencies are `androidx.webkit` and `androidx.core`.
- WebView usage metrics are opted out (`android.webkit.WebView.MetricsOptOut`).
- No cloud backup (`allowBackup="false"`, no `<cloud-backup>` rule).

## Things to know when you answer

- **Device-to-device transfer.** On Android 12 and later, when the user moves to a new device with Android's own transfer, the system can copy the app's WebView storage so the cat comes along. Android does this at the user's direction; the app sends nothing, and it never reaches the developer.
- **Uninstalling.** `hasFragileUserData` makes Android offer to keep the app's data on uninstall. Otherwise, uninstalling or clearing the app's data deletes the cat. Settings, **Start over with a new cat**, also deletes it. There is no server copy to delete, because none exists.
- **The floating cat (preview 2).** Its window reads only touches that land inside it, to move the cat; nothing is stored or sent, and it reads nothing from other apps (no screen capture, no accessibility service, no usage access). The answers above do not change, but the permission declarations in [permissions.md](permissions.md) are new work for the owner.
- **Web content.** Google asks for declarations when an app controls the content of its WebView. GizeCat does control it, and that content sends nothing, so the answer does not change.
- **Status.** All of this is from reading the code and the build configuration. Nothing has run on a device, and no network capture has been made (THEORETICALLY_COMPATIBLE_NOT_EXECUTED).

## Source

[Data safety form help](https://support.google.com/googleplay/android-developer/answer/10787469), checked on 2026-11-08.
