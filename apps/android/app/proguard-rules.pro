# The JavaScript interface is reached by name from the web app.
-keepclassmembers class app.krubot.android.KruBridge {
    @android.webkit.JavascriptInterface <methods>;
}
