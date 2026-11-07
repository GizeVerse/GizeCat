# No keep rules are needed: the manifest keeps MainActivity, and the app uses no reflection and no
# addJavascriptInterface object. The page talks to the native side only through the
# WebViewCompat web message listener (string messages), which R8 does not need to see.
