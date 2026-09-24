package app.krubot.android

import android.webkit.JavascriptInterface

/*
 * `window.kruMobile`, the one bridge between your Kru Bot's pages and the
 * app, the way `kruDesktop` is on the desktop. Anything that changes what
 * the app shows or does is handed to the activity, which acts only when
 * the page that asked belongs to the server it is connected to.
 */
class KruBridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun platform(): String = "android"

    @JavascriptInterface
    fun version(): String = BuildConfig.VERSION_NAME

    /** Back to Connect, with the current address filled in. */
    @JavascriptInterface
    fun changeServer() = activity.fromTrustedPage { showConnect(server, null) }

    /** A notification on the phone; tapping it opens `url` on the server. */
    @JavascriptInterface
    fun notify(title: String?, body: String?, url: String?, tag: String?) = activity.fromTrustedPage {
        Notifications.show(this, title.orEmpty().ifBlank { getString(R.string.app_name) }, body.orEmpty(), url ?: "/app", tag ?: url ?: "kru")
    }

    @JavascriptInterface
    fun notificationsState(): String = Notifications.state(activity)

    @JavascriptInterface
    fun requestNotifications() = activity.fromTrustedPage { askForNotifications() }

    /** Sign in with the OIDC provider in the phone's browser; the app opens `next` once signed in. */
    @JavascriptInterface
    fun signIn(next: String?) = activity.fromTrustedPage { startSignIn(next) }

    /** A link in the phone's browser rather than in the app. */
    @JavascriptInterface
    fun openExternal(url: String?) = activity.fromTrustedPage { if (url != null) openOutside(url) }

    /** The page's background and whether it is dark, so the bars around it match. */
    @JavascriptInterface
    fun setTheme(background: String?, dark: Boolean) = activity.fromTrustedPage { applyTheme(background, dark) }
}
