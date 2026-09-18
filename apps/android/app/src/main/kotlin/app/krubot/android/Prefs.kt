package app.krubot.android

import android.content.Context
import androidx.core.content.edit

/** What the app remembers: the server it is pointed at, and a sign-in waiting in the browser. */
object Prefs {
    private const val FILE = "kru"
    private const val SERVER = "server"
    private const val SIGN_IN_VERIFIER = "sign_in_verifier"
    private const val SIGN_IN_NEXT = "sign_in_next"

    fun server(context: Context): String? = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(SERVER, null)

    fun setServer(context: Context, origin: String) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit { putString(SERVER, origin) }
    }

    /** The verifier and the page to open after, kept while the sign-in is in the browser (the app may be stopped meanwhile). */
    fun setPendingSignIn(context: Context, verifier: String, next: String) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit { putString(SIGN_IN_VERIFIER, verifier).putString(SIGN_IN_NEXT, next) }
    }

    /** The pending sign-in, forgotten as it is read: a verifier is good for one try. */
    fun takePendingSignIn(context: Context): Pair<String, String>? {
        val prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        val verifier = prefs.getString(SIGN_IN_VERIFIER, null) ?: return null
        val next = prefs.getString(SIGN_IN_NEXT, null) ?: "/app"
        prefs.edit { remove(SIGN_IN_VERIFIER).remove(SIGN_IN_NEXT) }
        return verifier to next
    }
}
